/* eslint-disable @typescript-eslint/prefer-for-of */
/* eslint-disable no-continue */
import {deepEqual} from 'fast-equals';
import lodashClone from 'lodash/clone';
import type {ValueOf} from 'type-fest';
import DevTools from './DevTools';
import * as Logger from './Logger';
import type Onyx from './Onyx';
import cache from './OnyxCache';
import * as PerformanceUtils from './PerformanceUtils';
import * as Str from './Str';
import unstable_batchedUpdates from './batch';
import Storage from './storage';
import type {
    CollectionKey,
    CollectionKeyBase,
    DeepRecord,
    DefaultConnectCallback,
    DefaultConnectOptions,
    KeyValueMapping,
    Mapping,
    OnyxCollection,
    OnyxEntry,
    OnyxInput,
    OnyxKey,
    OnyxValue,
    Selector,
    WithOnyxConnectOptions,
} from './types';
import utils from './utils';
import type {WithOnyxState} from './withOnyx/types';

// Method constants
const METHOD = {
    SET: 'set',
    MERGE: 'merge',
    MERGE_COLLECTION: 'mergecollection',
    MULTI_SET: 'multiset',
    CLEAR: 'clear',
} as const;

type OnyxMethod = ValueOf<typeof METHOD>;

// Key/value store of Onyx key and arrays of values to merge
const mergeQueue: Record<OnyxKey, Array<OnyxValue<OnyxKey>>> = {};
const mergeQueuePromise: Record<OnyxKey, Promise<void>> = {};

// Holds a mapping of all the react components that want their state subscribed to a store key
const callbackToStateMapping: Record<string, Mapping<OnyxKey>> = {};

// Keeps a copy of the values of the onyx collection keys as a map for faster lookups
let onyxCollectionKeyMap = new Map<OnyxKey, OnyxValue<OnyxKey>>();

// Holds a list of keys that have been directly subscribed to or recently modified from least to most recent
let recentlyAccessedKeys: OnyxKey[] = [];

// Holds a list of keys that are safe to remove when we reach max storage. If a key does not match with
// whatever appears in this list it will NEVER be a candidate for eviction.
let evictionAllowList: OnyxKey[] = [];

// Holds a map of keys and connectionID arrays whose keys will never be automatically evicted as
// long as we have at least one subscriber that returns false for the canEvict property.
const evictionBlocklist: Record<OnyxKey, number[]> = {};

// Optional user-provided key value states set when Onyx initializes or clears
let defaultKeyStates: Record<OnyxKey, OnyxValue<OnyxKey>> = {};

let batchUpdatesPromise: Promise<void> | null = null;
let batchUpdatesQueue: Array<() => void> = [];

let snapshotKey: OnyxKey | null = null;

function getSnapshotKey(): OnyxKey | null {
    return snapshotKey;
}

/**
 * Getter - returns the merge queue.
 */
function getMergeQueue(): Record<OnyxKey, Array<OnyxValue<OnyxKey>>> {
    return mergeQueue;
}

/**
 * Getter - returns the merge queue promise.
 */
function getMergeQueuePromise(): Record<OnyxKey, Promise<void>> {
    return mergeQueuePromise;
}

/**
 * Getter - returns the callback to state mapping.
 */
function getCallbackToStateMapping(): Record<string, Mapping<OnyxKey>> {
    return callbackToStateMapping;
}

/**
 * Getter - returns the default key states.
 */
function getDefaultKeyStates(): Record<OnyxKey, OnyxValue<OnyxKey>> {
    return defaultKeyStates;
}

/**
 * Sets the initial values for the Onyx store
 *
 * @param keys - `ONYXKEYS` constants object from Onyx.init()
 * @param initialKeyStates - initial data to set when `init()` and `clear()` are called
 * @param safeEvictionKeys - This is an array of keys (individual or collection patterns) that when provided to Onyx are flagged as "safe" for removal.
 */
function initStoreValues(keys: DeepRecord<string, OnyxKey>, initialKeyStates: Partial<KeyValueMapping>, safeEvictionKeys: OnyxKey[]): void {
    // We need the value of the collection keys later for checking if a
    // key is a collection. We store it in a map for faster lookup.
    const collectionValues = Object.values(keys.COLLECTION ?? {});
    onyxCollectionKeyMap = collectionValues.reduce((acc, val) => {
        acc.set(val, true);
        return acc;
    }, new Map());

    // Set our default key states to use when initializing and clearing Onyx data
    defaultKeyStates = initialKeyStates;

    DevTools.initState(initialKeyStates);

    // Let Onyx know about which keys are safe to evict
    evictionAllowList = safeEvictionKeys;

    if (typeof keys.COLLECTION === 'object' && typeof keys.COLLECTION.SNAPSHOT === 'string') {
        snapshotKey = keys.COLLECTION.SNAPSHOT;
    }
}

/**
 * Sends an action to DevTools extension
 *
 * @param method - Onyx method from METHOD
 * @param key - Onyx key that was changed
 * @param value - contains the change that was made by the method
 * @param mergedValue - (optional) value that was written in the storage after a merge method was executed.
 */
function sendActionToDevTools(
    method: typeof METHOD.MERGE_COLLECTION | typeof METHOD.MULTI_SET,
    key: undefined,
    value: OnyxCollection<KeyValueMapping[OnyxKey]>,
    mergedValue?: undefined,
): void;
function sendActionToDevTools(
    method: Exclude<OnyxMethod, typeof METHOD.MERGE_COLLECTION | typeof METHOD.MULTI_SET>,
    key: OnyxKey,
    value: OnyxEntry<KeyValueMapping[OnyxKey]>,
    mergedValue?: OnyxEntry<KeyValueMapping[OnyxKey]>,
): void;
function sendActionToDevTools(
    method: OnyxMethod,
    key: OnyxKey | undefined,
    value: OnyxCollection<KeyValueMapping[OnyxKey]> | OnyxEntry<KeyValueMapping[OnyxKey]>,
    mergedValue: OnyxEntry<KeyValueMapping[OnyxKey]> = undefined,
): void {
    DevTools.registerAction(utils.formatActionName(method, key), value, key ? {[key]: mergedValue || value} : (value as OnyxCollection<KeyValueMapping[OnyxKey]>));
}

/**
 * We are batching together onyx updates. This helps with use cases where we schedule onyx updates after each other.
 * This happens for example in the Onyx.update function, where we process API responses that might contain a lot of
 * update operations. Instead of calling the subscribers for each update operation, we batch them together which will
 * cause react to schedule the updates at once instead of after each other. This is mainly a performance optimization.
 */
function maybeFlushBatchUpdates(): Promise<void> {
    if (batchUpdatesPromise) {
        return batchUpdatesPromise;
    }

    batchUpdatesPromise = new Promise((resolve) => {
        /* We use (setTimeout, 0) here which should be called once native module calls are flushed (usually at the end of the frame)
         * We may investigate if (setTimeout, 1) (which in React Native is equal to requestAnimationFrame) works even better
         * then the batch will be flushed on next frame.
         */
        setTimeout(() => {
            const updatesCopy = batchUpdatesQueue;
            batchUpdatesQueue = [];
            batchUpdatesPromise = null;
            unstable_batchedUpdates(() => {
                updatesCopy.forEach((applyUpdates) => {
                    applyUpdates();
                });
            });

            resolve();
        }, 0);
    });
    return batchUpdatesPromise;
}

function batchUpdates(updates: () => void): Promise<void> {
    batchUpdatesQueue.push(updates);
    return maybeFlushBatchUpdates();
}

/**
 * Takes a collection of items (eg. {testKey_1:{a:'a'}, testKey_2:{b:'b'}})
 * and runs it through a reducer function to return a subset of the data according to a selector.
 * The resulting collection will only contain items that are returned by the selector.
 */
function reduceCollectionWithSelector<TKey extends CollectionKeyBase, TMap, TReturn>(
    collection: OnyxCollection<KeyValueMapping[TKey]>,
    selector: Selector<TKey, TMap, TReturn>,
    withOnyxInstanceState: WithOnyxState<TMap> | undefined,
): Record<string, TReturn> {
    return Object.entries(collection ?? {}).reduce((finalCollection: Record<string, TReturn>, [key, item]) => {
        // eslint-disable-next-line no-param-reassign
        finalCollection[key] = selector(item, withOnyxInstanceState);

        return finalCollection;
    }, {});
}

/** Get some data from the store */
function get<TKey extends OnyxKey, TValue extends OnyxValue<TKey>>(key: TKey): Promise<TValue> {
    // When we already have the value in cache - resolve right away
    if (cache.hasCacheForKey(key)) {
        return Promise.resolve(cache.get(key) as TValue);
    }

    const taskName = `get:${key}`;

    // When a value retrieving task for this key is still running hook to it
    if (cache.hasPendingTask(taskName)) {
        return cache.getTaskPromise(taskName) as Promise<TValue>;
    }

    // Otherwise retrieve the value from storage and capture a promise to aid concurrent usages
    const promise = Storage.getItem(key)
        .then((val) => {
            if (val === undefined) {
                cache.addNullishStorageKey(key);
                return undefined;
            }

            cache.set(key, val);
            return val;
        })
        .catch((err) => Logger.logInfo(`Unable to get item from persistent storage. Key: ${key} Error: ${err}`));

    return cache.captureTask(taskName, promise) as Promise<TValue>;
}

// multiGet the data first from the cache and then from the storage for the missing keys.
function multiGet<TKey extends OnyxKey>(keys: CollectionKeyBase[]): Promise<Map<OnyxKey, OnyxValue<TKey>>> {
    // Keys that are not in the cache
    const missingKeys: OnyxKey[] = [];

    // Tasks that are pending
    const pendingTasks: Array<Promise<OnyxValue<TKey>>> = [];

    // Keys for the tasks that are pending
    const pendingKeys: OnyxKey[] = [];

    // Data to be sent back to the invoker
    const dataMap = new Map<OnyxKey, OnyxValue<TKey>>();

    /**
     * We are going to iterate over all the matching keys and check if we have the data in the cache.
     * If we do then we add it to the data object. If we do not have them, then we check if there is a pending task
     * for the key. If there is such task, then we add the promise to the pendingTasks array and the key to the pendingKeys
     * array. If there is no pending task then we add the key to the missingKeys array.
     *
     * These missingKeys will be later used to multiGet the data from the storage.
     */
    keys.forEach((key) => {
        const cacheValue = cache.get(key) as OnyxValue<TKey>;
        if (cacheValue) {
            dataMap.set(key, cacheValue);
            return;
        }

        const pendingKey = `get:${key}`;
        if (cache.hasPendingTask(pendingKey)) {
            pendingTasks.push(cache.getTaskPromise(pendingKey) as Promise<OnyxValue<TKey>>);
            pendingKeys.push(key);
        } else {
            missingKeys.push(key);
        }
    });

    return (
        Promise.all(pendingTasks)
            // Wait for all the pending tasks to resolve and then add the data to the data map.
            .then((values) => {
                values.forEach((value, index) => {
                    dataMap.set(pendingKeys[index], value);
                });

                return Promise.resolve();
            })
            // Get the missing keys using multiGet from the storage.
            .then(() => {
                if (missingKeys.length === 0) {
                    return Promise.resolve(undefined);
                }

                return Storage.multiGet(missingKeys);
            })
            // Add the data from the missing keys to the data map and also merge it to the cache.
            .then((values) => {
                if (!values || values.length === 0) {
                    return dataMap;
                }

                // temp object is used to merge the missing data into the cache
                const temp: OnyxCollection<KeyValueMapping[TKey]> = {};
                values.forEach(([key, value]) => {
                    dataMap.set(key, value as OnyxValue<TKey>);
                    temp[key] = value as OnyxValue<TKey>;
                });
                cache.merge(temp);
                return dataMap;
            })
    );
}

/** Returns current key names stored in persisted storage */
function getAllKeys(): Promise<Set<OnyxKey>> {
    // When we've already read stored keys, resolve right away
    const cachedKeys = cache.getAllKeys();
    if (cachedKeys.size > 0) {
        return Promise.resolve(cachedKeys);
    }

    const taskName = 'getAllKeys';

    // When a value retrieving task for all keys is still running hook to it
    if (cache.hasPendingTask(taskName)) {
        return cache.getTaskPromise(taskName) as Promise<Set<OnyxKey>>;
    }

    // Otherwise retrieve the keys from storage and capture a promise to aid concurrent usages
    const promise = Storage.getAllKeys().then((keys) => {
        cache.setAllKeys(keys);

        // return the updated set of keys
        return cache.getAllKeys();
    });

    return cache.captureTask(taskName, promise) as Promise<Set<OnyxKey>>;
}

/**
 * Checks to see if the a subscriber's supplied key
 * is associated with a collection of keys.
 */
function isCollectionKey(key: OnyxKey): key is CollectionKeyBase {
    return onyxCollectionKeyMap.has(key);
}

function isCollectionMemberKey<TCollectionKey extends CollectionKeyBase>(collectionKey: TCollectionKey, key: string): key is `${TCollectionKey}${string}` {
    return Str.startsWith(key, collectionKey) && key.length > collectionKey.length;
}

/**
 * Splits a collection member key into the collection key part and the ID part.
 * @param key - The collection member key to split.
 * @returns A tuple where the first element is the collection part and the second element is the ID part.
 */
function splitCollectionMemberKey<TKey extends CollectionKey>(key: TKey): [TKey extends `${infer Prefix}_${string}` ? `${Prefix}_` : never, string] {
    const underscoreIndex = key.indexOf('_');

    if (underscoreIndex === -1) {
        throw new Error(`Invalid ${key} key provided, only collection keys are allowed.`);
    }

    return [key.substring(0, underscoreIndex + 1) as TKey extends `${infer Prefix}_${string}` ? `${Prefix}_` : never, key.substring(underscoreIndex + 1)];
}

/**
 * Checks to see if a provided key is the exact configured key of our connected subscriber
 * or if the provided key is a collection member key (in case our configured key is a "collection key")
 */
function isKeyMatch(configKey: OnyxKey, key: OnyxKey): boolean {
    return isCollectionKey(configKey) ? Str.startsWith(key, configKey) : configKey === key;
}

/** Checks to see if this key has been flagged as safe for removal. */
function isSafeEvictionKey(testKey: OnyxKey): boolean {
    return evictionAllowList.some((key) => isKeyMatch(key, testKey));
}

/**
 * Tries to get a value from the cache. If the value is not present in cache it will return the default value or undefined.
 * If the requested key is a collection, it will return an object with all the collection members.
 */
function tryGetCachedValue<TKey extends OnyxKey>(key: TKey, mapping?: Partial<WithOnyxConnectOptions<TKey>>): OnyxValue<OnyxKey> {
    let val = cache.get(key);

    if (isCollectionKey(key)) {
        const allCacheKeys = cache.getAllKeys();

        // It is possible we haven't loaded all keys yet so we do not know if the
        // collection actually exists.
        if (allCacheKeys.size === 0) {
            return;
        }

        const values: OnyxCollection<KeyValueMapping[TKey]> = {};
        allCacheKeys.forEach((cacheKey) => {
            if (!cacheKey.startsWith(key)) {
                return;
            }

            values[cacheKey] = cache.get(cacheKey);
        });
        val = values;
    }

    if (mapping?.selector) {
        const state = mapping.withOnyxInstance ? mapping.withOnyxInstance.state : undefined;
        if (isCollectionKey(key)) {
            return reduceCollectionWithSelector(val as OnyxCollection<KeyValueMapping[TKey]>, mapping.selector, state);
        }
        return mapping.selector(val, state);
    }

    return val;
}

/**
 * Remove a key from the recently accessed key list.
 */
function removeLastAccessedKey(key: OnyxKey): void {
    recentlyAccessedKeys = recentlyAccessedKeys.filter((recentlyAccessedKey) => recentlyAccessedKey !== key);
}

/**
 * Add a key to the list of recently accessed keys. The least
 * recently accessed key should be at the head and the most
 * recently accessed key at the tail.
 */
function addLastAccessedKey(key: OnyxKey): void {
    // Only specific keys belong in this list since we cannot remove an entire collection.
    if (isCollectionKey(key) || !isSafeEvictionKey(key)) {
        return;
    }

    removeLastAccessedKey(key);
    recentlyAccessedKeys.push(key);
}

/**
 * Removes a key previously added to this list
 * which will enable it to be deleted again.
 */
function removeFromEvictionBlockList(key: OnyxKey, connectionID: number): void {
    evictionBlocklist[key] = evictionBlocklist[key]?.filter((evictionKey) => evictionKey !== connectionID) ?? [];

    // Remove the key if there are no more subscribers
    if (evictionBlocklist[key]?.length === 0) {
        delete evictionBlocklist[key];
    }
}

/** Keys added to this list can never be deleted. */
function addToEvictionBlockList(key: OnyxKey, connectionID: number): void {
    removeFromEvictionBlockList(key, connectionID);

    if (!evictionBlocklist[key]) {
        evictionBlocklist[key] = [];
    }

    evictionBlocklist[key].push(connectionID);
}

/**
 * Take all the keys that are safe to evict and add them to
 * the recently accessed list when initializing the app. This
 * enables keys that have not recently been accessed to be
 * removed.
 */
function addAllSafeEvictionKeysToRecentlyAccessedList(): Promise<void> {
    return getAllKeys().then((keys) => {
        evictionAllowList.forEach((safeEvictionKey) => {
            keys.forEach((key) => {
                if (!isKeyMatch(safeEvictionKey, key)) {
                    return;
                }
                addLastAccessedKey(key);
            });
        });
    });
}

function getCachedCollection<TKey extends CollectionKeyBase>(collectionKey: TKey, collectionMemberKeys?: string[]): NonNullable<OnyxCollection<KeyValueMapping[TKey]>> {
    const allKeys = collectionMemberKeys || cache.getAllKeys();
    const collection: OnyxCollection<KeyValueMapping[TKey]> = {};

    // forEach exists on both Set and Array
    allKeys.forEach((key) => {
        // If we don't have collectionMemberKeys array then we have to check whether a key is a collection member key.
        // Because in that case the keys will be coming from `cache.getAllKeys()` and we need to filter out the keys that
        // are not part of the collection.
        if (!collectionMemberKeys && !isCollectionMemberKey(collectionKey, key)) {
            return;
        }

        const cachedValue = cache.get(key);

        if (cachedValue === undefined && !cache.hasNullishStorageKey(key)) {
            return;
        }

        collection[key] = cache.get(key);
    });

    return collection;
}

/**
 * When a collection of keys change, search for any callbacks matching the collection key and trigger those callbacks
 */
function keysChanged<TKey extends CollectionKeyBase>(
    collectionKey: TKey,
    partialCollection: OnyxCollection<KeyValueMapping[TKey]>,
    partialPreviousCollection: OnyxCollection<KeyValueMapping[TKey]> | undefined,
    notifyRegularSubscibers = true,
    notifyWithOnyxSubscibers = true,
): void {
    // We prepare the "cached collection" which is the entire collection + the new partial data that
    // was merged in via mergeCollection().
    const cachedCollection = getCachedCollection(collectionKey);

    const previousCollection = partialPreviousCollection ?? {};

    // We are iterating over all subscribers similar to keyChanged(). However, we are looking for subscribers who are subscribing to either a collection key or
    // individual collection key member for the collection that is being updated. It is important to note that the collection parameter cane be a PARTIAL collection
    // and does not represent all of the combined keys and values for a collection key. It is just the "new" data that was merged in via mergeCollection().
    const stateMappingKeys = Object.keys(callbackToStateMapping);
    for (let i = 0; i < stateMappingKeys.length; i++) {
        const subscriber = callbackToStateMapping[stateMappingKeys[i]];
        if (!subscriber) {
            continue;
        }

        // Skip iteration if we do not have a collection key or a collection member key on this subscriber
        if (!Str.startsWith(subscriber.key, collectionKey)) {
            continue;
        }

        /**
         * e.g. Onyx.connect({key: ONYXKEYS.COLLECTION.REPORT, callback: ...});
         */
        const isSubscribedToCollectionKey = subscriber.key === collectionKey;

        /**
         * e.g. Onyx.connect({key: `${ONYXKEYS.COLLECTION.REPORT}{reportID}`, callback: ...});
         */
        const isSubscribedToCollectionMemberKey = isCollectionMemberKey(collectionKey, subscriber.key);

        // Regular Onyx.connect() subscriber found.
        if (typeof subscriber.callback === 'function') {
            if (!notifyRegularSubscibers) {
                continue;
            }

            // If they are subscribed to the collection key and using waitForCollectionCallback then we'll
            // send the whole cached collection.
            if (isSubscribedToCollectionKey) {
                if (subscriber.waitForCollectionCallback) {
                    subscriber.callback(cachedCollection);
                    continue;
                }

                // If they are not using waitForCollectionCallback then we notify the subscriber with
                // the new merged data but only for any keys in the partial collection.
                const dataKeys = Object.keys(partialCollection ?? {});
                for (let j = 0; j < dataKeys.length; j++) {
                    const dataKey = dataKeys[j];

                    if (deepEqual(cachedCollection[dataKey], previousCollection[dataKey])) {
                        continue;
                    }

                    subscriber.callback(cachedCollection[dataKey], dataKey);
                }
                continue;
            }

            // And if the subscriber is specifically only tracking a particular collection member key then we will
            // notify them with the cached data for that key only.
            if (isSubscribedToCollectionMemberKey) {
                if (deepEqual(cachedCollection[subscriber.key], previousCollection[subscriber.key])) {
                    continue;
                }

                const subscriberCallback = subscriber.callback as DefaultConnectCallback<TKey>;
                subscriberCallback(cachedCollection[subscriber.key], subscriber.key as TKey);
                continue;
            }

            continue;
        }

        // React component subscriber found.
        if ('withOnyxInstance' in subscriber && subscriber.withOnyxInstance) {
            if (!notifyWithOnyxSubscibers) {
                continue;
            }

            // We are subscribed to a collection key so we must update the data in state with the new
            // collection member key values from the partial update.
            if (isSubscribedToCollectionKey) {
                // If the subscriber has a selector, then the component's state must only be updated with the data
                // returned by the selector.
                const collectionSelector = subscriber.selector;
                if (collectionSelector) {
                    subscriber.withOnyxInstance.setStateProxy((prevState) => {
                        const previousData = prevState[subscriber.statePropertyName];
                        const newData = reduceCollectionWithSelector(cachedCollection, collectionSelector, subscriber.withOnyxInstance.state);

                        if (deepEqual(previousData, newData)) {
                            return null;
                        }

                        return {
                            [subscriber.statePropertyName]: newData,
                        };
                    });
                    continue;
                }

                subscriber.withOnyxInstance.setStateProxy((prevState) => {
                    const prevCollection = prevState?.[subscriber.statePropertyName] ?? {};
                    const finalCollection = lodashClone(prevCollection);
                    const dataKeys = Object.keys(partialCollection ?? {});
                    for (let j = 0; j < dataKeys.length; j++) {
                        const dataKey = dataKeys[j];
                        finalCollection[dataKey] = cachedCollection[dataKey];
                    }

                    if (deepEqual(prevCollection, finalCollection)) {
                        return null;
                    }

                    PerformanceUtils.logSetStateCall(subscriber, prevState?.[subscriber.statePropertyName], finalCollection, 'keysChanged', collectionKey);
                    return {
                        [subscriber.statePropertyName]: finalCollection,
                    };
                });
                continue;
            }

            // If a React component is only interested in a single key then we can set the cached value directly to the state name.
            if (isSubscribedToCollectionMemberKey) {
                if (deepEqual(cachedCollection[subscriber.key], previousCollection[subscriber.key])) {
                    continue;
                }

                // However, we only want to update this subscriber if the partial data contains a change.
                // Otherwise, we would update them with a value they already have and trigger an unnecessary re-render.
                const dataFromCollection = partialCollection?.[subscriber.key];
                if (dataFromCollection === undefined) {
                    continue;
                }

                // If the subscriber has a selector, then the component's state must only be updated with the data
                // returned by the selector and the state should only change when the subset of data changes from what
                // it was previously.
                const selector = subscriber.selector;
                if (selector) {
                    subscriber.withOnyxInstance.setStateProxy((prevState) => {
                        const prevData = prevState[subscriber.statePropertyName];
                        const newData = selector(cachedCollection[subscriber.key], subscriber.withOnyxInstance.state);

                        if (deepEqual(prevData, newData)) {
                            return null;
                        }

                        PerformanceUtils.logSetStateCall(subscriber, prevData, newData, 'keysChanged', collectionKey);
                        return {
                            [subscriber.statePropertyName]: newData,
                        };
                    });
                    continue;
                }

                subscriber.withOnyxInstance.setStateProxy((prevState) => {
                    const prevData = prevState[subscriber.statePropertyName];
                    const newData = cachedCollection[subscriber.key];

                    // Avoids triggering unnecessary re-renders when feeding empty objects
                    if (utils.isEmptyObject(newData) && utils.isEmptyObject(prevData)) {
                        return null;
                    }

                    if (deepEqual(prevData, newData)) {
                        return null;
                    }

                    PerformanceUtils.logSetStateCall(subscriber, prevData, newData, 'keysChanged', collectionKey);
                    return {
                        [subscriber.statePropertyName]: newData,
                    };
                });
            }
        }
    }
}

/**
 * When a key change happens, search for any callbacks matching the key or collection key and trigger those callbacks
 *
 * @example
 * keyChanged(key, value, subscriber => subscriber.initWithStoredValues === false)
 */
function keyChanged<TKey extends OnyxKey>(
    key: TKey,
    value: OnyxValue<TKey>,
    previousValue: OnyxValue<TKey>,
    canUpdateSubscriber: (subscriber?: Mapping<OnyxKey>) => boolean = () => true,
    notifyRegularSubscibers = true,
    notifyWithOnyxSubscibers = true,
): void {
    // Add or remove this key from the recentlyAccessedKeys lists
    if (value !== null) {
        addLastAccessedKey(key);
    } else {
        removeLastAccessedKey(key);
    }

    // We are iterating over all subscribers to see if they are interested in the key that has just changed. If the subscriber's  key is a collection key then we will
    // notify them if the key that changed is a collection member. Or if it is a regular key notify them when there is an exact match. Depending on whether the subscriber
    // was connected via withOnyx we will call setState() directly on the withOnyx instance. If it is a regular connection we will pass the data to the provided callback.
    const stateMappingKeys = Object.keys(callbackToStateMapping);
    for (let i = 0; i < stateMappingKeys.length; i++) {
        const subscriber = callbackToStateMapping[stateMappingKeys[i]];
        if (!subscriber || !isKeyMatch(subscriber.key, key) || !canUpdateSubscriber(subscriber)) {
            continue;
        }

        // Subscriber is a regular call to connect() and provided a callback
        if (typeof subscriber.callback === 'function') {
            if (!notifyRegularSubscibers) {
                continue;
            }
            if (isCollectionKey(subscriber.key) && subscriber.waitForCollectionCallback) {
                const cachedCollection = getCachedCollection(subscriber.key);

                cachedCollection[key] = value;
                subscriber.callback(cachedCollection);
                continue;
            }

            const subscriberCallback = subscriber.callback as DefaultConnectCallback<TKey>;
            subscriberCallback(value, key);
            continue;
        }

        // Subscriber connected via withOnyx() HOC
        if ('withOnyxInstance' in subscriber && subscriber.withOnyxInstance) {
            if (!notifyWithOnyxSubscibers) {
                continue;
            }

            const selector = subscriber.selector;
            // Check if we are subscribing to a collection key and overwrite the collection member key value in state
            if (isCollectionKey(subscriber.key)) {
                // If the subscriber has a selector, then the consumer of this data must only be given the data
                // returned by the selector and only when the selected data has changed.
                if (selector) {
                    subscriber.withOnyxInstance.setStateProxy((prevState) => {
                        const prevWithOnyxData = prevState[subscriber.statePropertyName];
                        const newWithOnyxData = {
                            [key]: selector(value, subscriber.withOnyxInstance.state),
                        };
                        const prevDataWithNewData = {
                            ...prevWithOnyxData,
                            ...newWithOnyxData,
                        };

                        if (deepEqual(prevWithOnyxData, prevDataWithNewData)) {
                            return null;
                        }

                        PerformanceUtils.logSetStateCall(subscriber, prevWithOnyxData, newWithOnyxData, 'keyChanged', key);
                        return {
                            [subscriber.statePropertyName]: prevDataWithNewData,
                        };
                    });
                    continue;
                }

                subscriber.withOnyxInstance.setStateProxy((prevState) => {
                    const prevCollection = prevState[subscriber.statePropertyName] || {};
                    const newCollection = {
                        ...prevCollection,
                        [key]: value,
                    };

                    if (deepEqual(prevCollection, newCollection)) {
                        return null;
                    }

                    PerformanceUtils.logSetStateCall(subscriber, prevCollection, newCollection, 'keyChanged', key);
                    return {
                        [subscriber.statePropertyName]: newCollection,
                    };
                });
                continue;
            }

            // If the subscriber has a selector, then the component's state must only be updated with the data
            // returned by the selector and only if the selected data has changed.
            if (selector) {
                subscriber.withOnyxInstance.setStateProxy(() => {
                    const prevValue = selector(previousValue, subscriber.withOnyxInstance.state);
                    const newValue = selector(value, subscriber.withOnyxInstance.state);

                    if (deepEqual(prevValue, newValue)) {
                        return null;
                    }

                    return {
                        [subscriber.statePropertyName]: newValue,
                    };
                });
                continue;
            }

            // If we did not match on a collection key then we just set the new data to the state property
            subscriber.withOnyxInstance.setStateProxy((prevState) => {
                const prevWithOnyxValue = prevState[subscriber.statePropertyName];

                // Avoids triggering unnecessary re-renders when feeding empty objects
                if (utils.isEmptyObject(value) && utils.isEmptyObject(prevWithOnyxValue)) {
                    return null;
                }
                if (prevWithOnyxValue === value) {
                    return null;
                }

                PerformanceUtils.logSetStateCall(subscriber, previousValue, value, 'keyChanged', key);
                return {
                    [subscriber.statePropertyName]: value,
                };
            });
            continue;
        }

        console.error('Warning: Found a matching subscriber to a key that changed, but no callback or withOnyxInstance could be found.');
    }
}

/**
 * Sends the data obtained from the keys to the connection. It either:
 *     - sets state on the withOnyxInstances
 *     - triggers the callback function
 */
function sendDataToConnection<TKey extends OnyxKey>(mapping: Mapping<TKey>, value: OnyxValue<TKey> | null, matchedKey: TKey | undefined, isBatched: boolean): void {
    // If the mapping no longer exists then we should not send any data.
    // This means our subscriber disconnected or withOnyx wrapped component unmounted.
    if (!callbackToStateMapping[mapping.connectionID]) {
        return;
    }

    if ('withOnyxInstance' in mapping && mapping.withOnyxInstance) {
        let newData: OnyxValue<OnyxKey> = value;

        // If the mapping has a selector, then the component's state must only be updated with the data
        // returned by the selector.
        if (mapping.selector) {
            if (isCollectionKey(mapping.key)) {
                newData = reduceCollectionWithSelector(value as OnyxCollection<KeyValueMapping[TKey]>, mapping.selector, mapping.withOnyxInstance.state);
            } else {
                newData = mapping.selector(value, mapping.withOnyxInstance.state);
            }
        }

        PerformanceUtils.logSetStateCall(mapping, null, newData, 'sendDataToConnection');
        if (isBatched) {
            batchUpdates(() => mapping.withOnyxInstance.setWithOnyxState(mapping.statePropertyName, newData));
        } else {
            mapping.withOnyxInstance.setWithOnyxState(mapping.statePropertyName, newData);
        }
        return;
    }

    // When there are no matching keys in "Onyx.connect", we pass null to "sendDataToConnection" explicitly,
    // to allow the withOnyx instance to set the value in the state initially and therefore stop the loading state once all
    // required keys have been set.
    // If we would pass undefined to setWithOnyxInstance instead, withOnyx would not set the value in the state.
    // withOnyx will internally replace null values with undefined and never pass null values to wrapped components.
    // For regular callbacks, we never want to pass null values, but always just undefined if a value is not set in cache or storage.
    (mapping as DefaultConnectOptions<TKey>).callback?.(value === null ? undefined : value, matchedKey as TKey);
}

/**
 * We check to see if this key is flagged as safe for eviction and add it to the recentlyAccessedKeys list so that when we
 * run out of storage the least recently accessed key can be removed.
 */
function addKeyToRecentlyAccessedIfNeeded<TKey extends OnyxKey>(mapping: Mapping<TKey>): void {
    if (!isSafeEvictionKey(mapping.key)) {
        return;
    }

    // Try to free some cache whenever we connect to a safe eviction key
    cache.removeLeastRecentlyUsedKeys();

    if ('withOnyxInstance' in mapping && mapping.withOnyxInstance && !isCollectionKey(mapping.key)) {
        // All React components subscribing to a key flagged as a safe eviction key must implement the canEvict property.
        if (mapping.canEvict === undefined) {
            throw new Error(`Cannot subscribe to safe eviction key '${mapping.key}' without providing a canEvict value.`);
        }

        addLastAccessedKey(mapping.key);
    }
}

/**
 * Gets the data for a given an array of matching keys, combines them into an object, and sends the result back to the subscriber.
 */
function getCollectionDataAndSendAsObject<TKey extends OnyxKey>(matchingKeys: CollectionKeyBase[], mapping: Mapping<TKey>): void {
    multiGet(matchingKeys).then((dataMap) => {
        const data = Object.fromEntries(dataMap.entries()) as OnyxValue<TKey>;
        sendDataToConnection(mapping, data, undefined, true);
    });
}

/**
 * Schedules an update that will be appended to the macro task queue (so it doesn't update the subscribers immediately).
 *
 * @example
 * scheduleSubscriberUpdate(key, value, subscriber => subscriber.initWithStoredValues === false)
 */
function scheduleSubscriberUpdate<TKey extends OnyxKey>(
    key: TKey,
    value: OnyxValue<TKey>,
    previousValue: OnyxValue<TKey>,
    canUpdateSubscriber: (subscriber?: Mapping<OnyxKey>) => boolean = () => true,
): Promise<void> {
    const promise = Promise.resolve().then(() => keyChanged(key, value, previousValue, canUpdateSubscriber, true, false));
    batchUpdates(() => keyChanged(key, value, previousValue, canUpdateSubscriber, false, true));
    return Promise.all([maybeFlushBatchUpdates(), promise]).then(() => undefined);
}

/**
 * This method is similar to notifySubscribersOnNextTick but it is built for working specifically with collections
 * so that keysChanged() is triggered for the collection and not keyChanged(). If this was not done, then the
 * subscriber callbacks receive the data in a different format than they normally expect and it breaks code.
 */
function scheduleNotifyCollectionSubscribers<TKey extends OnyxKey>(
    key: TKey,
    value: OnyxCollection<KeyValueMapping[TKey]>,
    previousValue?: OnyxCollection<KeyValueMapping[TKey]>,
): Promise<void> {
    const promise = Promise.resolve().then(() => keysChanged(key, value, previousValue, true, false));
    batchUpdates(() => keysChanged(key, value, previousValue, false, true));
    return Promise.all([maybeFlushBatchUpdates(), promise]).then(() => undefined);
}

/**
 * Remove a key from Onyx and update the subscribers
 */
function remove<TKey extends OnyxKey>(key: TKey): Promise<void> {
    const prevValue = cache.get(key, false) as OnyxValue<TKey>;
    cache.drop(key);
    scheduleSubscriberUpdate(key, undefined as OnyxValue<TKey>, prevValue);
    return Storage.removeItem(key).then(() => undefined);
}

function reportStorageQuota(): Promise<void> {
    return Storage.getDatabaseSize()
        .then(({bytesUsed, bytesRemaining}) => {
            Logger.logInfo(`Storage Quota Check -- bytesUsed: ${bytesUsed} bytesRemaining: ${bytesRemaining}`);
        })
        .catch((dbSizeError) => {
            Logger.logAlert(`Unable to get database size. Error: ${dbSizeError}`);
        });
}

/**
 * If we fail to set or merge we must handle this by
 * evicting some data from Onyx and then retrying to do
 * whatever it is we attempted to do.
 */
function evictStorageAndRetry<TMethod extends typeof Onyx.set | typeof Onyx.multiSet | typeof Onyx.mergeCollection>(
    error: Error,
    onyxMethod: TMethod,
    ...args: Parameters<TMethod>
): Promise<void> {
    Logger.logInfo(`Failed to save to storage. Error: ${error}. onyxMethod: ${onyxMethod.name}`);

    if (error && Str.startsWith(error.message, "Failed to execute 'put' on 'IDBObjectStore'")) {
        Logger.logAlert('Attempted to set invalid data set in Onyx. Please ensure all data is serializable.');
        throw error;
    }

    // Find the first key that we can remove that has no subscribers in our blocklist
    const keyForRemoval = recentlyAccessedKeys.find((key) => !evictionBlocklist[key]);
    if (!keyForRemoval) {
        // If we have no acceptable keys to remove then we are possibly trying to save mission critical data. If this is the case,
        // then we should stop retrying as there is not much the user can do to fix this. Instead of getting them stuck in an infinite loop we
        // will allow this write to be skipped.
        Logger.logAlert('Out of storage. But found no acceptable keys to remove.');
        return reportStorageQuota();
    }

    // Remove the least recently viewed key that is not currently being accessed and retry.
    Logger.logInfo(`Out of storage. Evicting least recently accessed key (${keyForRemoval}) and retrying.`);
    reportStorageQuota();

    // @ts-expect-error No overload matches this call.
    return remove(keyForRemoval).then(() => onyxMethod(...args));
}

/**
 * Notifies subscribers and writes current value to cache
 */
function broadcastUpdate<TKey extends OnyxKey>(key: TKey, value: OnyxValue<TKey>, hasChanged?: boolean): Promise<void> {
    const prevValue = cache.get(key, false) as OnyxValue<TKey>;

    // Update subscribers if the cached value has changed, or when the subscriber specifically requires
    // all updates regardless of value changes (indicated by initWithStoredValues set to false).
    if (hasChanged) {
        cache.set(key, value);
    } else {
        cache.addToAccessedKeys(key);
    }

    return scheduleSubscriberUpdate(key, value, prevValue, (subscriber) => hasChanged || subscriber?.initWithStoredValues === false).then(() => undefined);
}

function hasPendingMergeForKey(key: OnyxKey): boolean {
    return !!mergeQueue[key];
}

type RemoveNullValuesOutput<Value extends OnyxInput<OnyxKey> | undefined> = {
    value: Value;
    wasRemoved: boolean;
};

/**
 * Removes a key from storage if the value is null.
 * Otherwise removes all nested null values in objects,
 * if shouldRemoveNestedNulls is true and returns the object.
 *
 * @returns The value without null values and a boolean "wasRemoved", which indicates if the key got removed completely
 */
function removeNullValues<Value extends OnyxInput<OnyxKey> | undefined>(key: OnyxKey, value: Value, shouldRemoveNestedNulls = true): RemoveNullValuesOutput<Value> {
    if (value === null) {
        remove(key);
        return {value, wasRemoved: true};
    }

    if (value === undefined) {
        return {value, wasRemoved: false};
    }

    // We can remove all null values in an object by merging it with itself
    // utils.fastMerge recursively goes through the object and removes all null values
    // Passing two identical objects as source and target to fastMerge will not change it, but only remove the null values
    return {value: shouldRemoveNestedNulls ? utils.removeNestedNullValues(value) : value, wasRemoved: false};
}

/**
 * Storage expects array like: [["@MyApp_user", value_1], ["@MyApp_key", value_2]]
 * This method transforms an object like {'@MyApp_user': myUserValue, '@MyApp_key': myKeyValue}
 * to an array of key-value pairs in the above format and removes key-value pairs that are being set to null

* @return an array of key - value pairs <[key, value]>
 */
function prepareKeyValuePairsForStorage(data: Record<OnyxKey, OnyxInput<OnyxKey>>, shouldRemoveNestedNulls: boolean): Array<[OnyxKey, OnyxInput<OnyxKey>]> {
    return Object.entries(data).reduce<Array<[OnyxKey, OnyxInput<OnyxKey>]>>((pairs, [key, value]) => {
        const {value: valueAfterRemoving, wasRemoved} = removeNullValues(key, value, shouldRemoveNestedNulls);

        if (!wasRemoved && valueAfterRemoving !== undefined) {
            pairs.push([key, valueAfterRemoving]);
        }

        return pairs;
    }, []);
}

/**
 * Merges an array of changes with an existing value
 *
 * @param changes Array of changes that should be applied to the existing value
 */
function applyMerge<TValue extends OnyxInput<OnyxKey> | undefined, TChange extends OnyxInput<OnyxKey> | undefined>(
    existingValue: TValue,
    changes: TChange[],
    shouldRemoveNestedNulls: boolean,
): TChange {
    const lastChange = changes?.at(-1);

    if (Array.isArray(lastChange)) {
        return lastChange;
    }

    if (changes.some((change) => change && typeof change === 'object')) {
        // Object values are then merged one after the other
        return changes.reduce((modifiedData, change) => utils.fastMerge(modifiedData, change, shouldRemoveNestedNulls), (existingValue || {}) as TChange);
    }

    // If we have anything else we can't merge it so we'll
    // simply return the last value that was queued
    return lastChange as TChange;
}

/**
 * Merge user provided default key value pairs.
 */
function initializeWithDefaultKeyStates(): Promise<void> {
    return Storage.multiGet(Object.keys(defaultKeyStates)).then((pairs) => {
        const existingDataAsObject = Object.fromEntries(pairs);

        const merged = utils.fastMerge(existingDataAsObject, defaultKeyStates);
        cache.merge(merged ?? {});

        Object.entries(merged ?? {}).forEach(([key, value]) => keyChanged(key, value, existingDataAsObject));
    });
}

const OnyxUtils = {
    METHOD,
    getMergeQueue,
    getMergeQueuePromise,
    getCallbackToStateMapping,
    getDefaultKeyStates,
    initStoreValues,
    sendActionToDevTools,
    maybeFlushBatchUpdates,
    batchUpdates,
    get,
    getAllKeys,
    isCollectionKey,
    isCollectionMemberKey,
    splitCollectionMemberKey,
    isKeyMatch,
    isSafeEvictionKey,
    tryGetCachedValue,
    removeLastAccessedKey,
    addLastAccessedKey,
    removeFromEvictionBlockList,
    addToEvictionBlockList,
    addAllSafeEvictionKeysToRecentlyAccessedList,
    getCachedCollection,
    keysChanged,
    keyChanged,
    sendDataToConnection,
    addKeyToRecentlyAccessedIfNeeded,
    getCollectionDataAndSendAsObject,
    scheduleSubscriberUpdate,
    scheduleNotifyCollectionSubscribers,
    remove,
    reportStorageQuota,
    evictStorageAndRetry,
    broadcastUpdate,
    hasPendingMergeForKey,
    removeNullValues,
    prepareKeyValuePairsForStorage,
    applyMerge,
    initializeWithDefaultKeyStates,
    getSnapshotKey,
    multiGet,
};

export default OnyxUtils;
