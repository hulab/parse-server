"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CacheAdapter = void 0;
/* eslint-disable unused-imports/no-unused-vars */
/**
 * @interface
 * @memberof module:Adapters
 */
class CacheAdapter {
  /**
   * Get a value in the cache
   * @param {String} key Cache key to get
   * @return {Promise} that will eventually resolve to the value in the cache.
   */
  get(key) {}

  /**
   * Set a value in the cache
   * @param {String} key Cache key to set
   * @param {String} value Value to set the key
   * @param {String} ttl Optional TTL
   */
  put(key, value, ttl) {}

  /**
   * Remove a value from the cache.
   * @param {String} key Cache key to remove
   */
  del(key) {}

  /**
   * Empty a cache
   * @param {String} prefix Cache key prefix to remove
   */
  clear(prefix) {}
}
exports.CacheAdapter = CacheAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJDYWNoZUFkYXB0ZXIiLCJnZXQiLCJrZXkiLCJwdXQiLCJ2YWx1ZSIsInR0bCIsImRlbCIsImNsZWFyIiwicHJlZml4IiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9DYWNoZS9DYWNoZUFkYXB0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgdW51c2VkLWltcG9ydHMvbm8tdW51c2VkLXZhcnMgKi9cbi8qKlxuICogQGludGVyZmFjZVxuICogQG1lbWJlcm9mIG1vZHVsZTpBZGFwdGVyc1xuICovXG5leHBvcnQgY2xhc3MgQ2FjaGVBZGFwdGVyIHtcbiAgLyoqXG4gICAqIEdldCBhIHZhbHVlIGluIHRoZSBjYWNoZVxuICAgKiBAcGFyYW0ge1N0cmluZ30ga2V5IENhY2hlIGtleSB0byBnZXRcbiAgICogQHJldHVybiB7UHJvbWlzZX0gdGhhdCB3aWxsIGV2ZW50dWFsbHkgcmVzb2x2ZSB0byB0aGUgdmFsdWUgaW4gdGhlIGNhY2hlLlxuICAgKi9cbiAgZ2V0KGtleSkge31cblxuICAvKipcbiAgICogU2V0IGEgdmFsdWUgaW4gdGhlIGNhY2hlXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBrZXkgQ2FjaGUga2V5IHRvIHNldFxuICAgKiBAcGFyYW0ge1N0cmluZ30gdmFsdWUgVmFsdWUgdG8gc2V0IHRoZSBrZXlcbiAgICogQHBhcmFtIHtTdHJpbmd9IHR0bCBPcHRpb25hbCBUVExcbiAgICovXG4gIHB1dChrZXksIHZhbHVlLCB0dGwpIHt9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBhIHZhbHVlIGZyb20gdGhlIGNhY2hlLlxuICAgKiBAcGFyYW0ge1N0cmluZ30ga2V5IENhY2hlIGtleSB0byByZW1vdmVcbiAgICovXG4gIGRlbChrZXkpIHt9XG5cbiAgLyoqXG4gICAqIEVtcHR5IGEgY2FjaGVcbiAgICogQHBhcmFtIHtTdHJpbmd9IHByZWZpeCBDYWNoZSBrZXkgcHJlZml4IHRvIHJlbW92ZVxuICAgKi9cbiAgY2xlYXIocHJlZml4KSB7fVxufVxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ08sTUFBTUEsWUFBWSxDQUFDO0VBQ3hCO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7RUFDRUMsR0FBR0EsQ0FBQ0MsR0FBRyxFQUFFLENBQUM7O0VBRVY7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0VDLEdBQUdBLENBQUNELEdBQUcsRUFBRUUsS0FBSyxFQUFFQyxHQUFHLEVBQUUsQ0FBQzs7RUFFdEI7QUFDRjtBQUNBO0FBQ0E7RUFDRUMsR0FBR0EsQ0FBQ0osR0FBRyxFQUFFLENBQUM7O0VBRVY7QUFDRjtBQUNBO0FBQ0E7RUFDRUssS0FBS0EsQ0FBQ0MsTUFBTSxFQUFFLENBQUM7QUFDakI7QUFBQ0MsT0FBQSxDQUFBVCxZQUFBLEdBQUFBLFlBQUEiLCJpZ25vcmVMaXN0IjpbXX0=