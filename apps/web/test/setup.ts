/**
 * Real IndexedDB semantics in Node: transactions, key ordering, autoIncrement
 * and structured cloning all behave as they do in a browser, so the tests
 * exercise the same code paths a device does.
 */
import 'fake-indexeddb/auto'
