"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CacheAdapter = void 0;

/*eslint no-unused-vars: "off"*/

/**
 * @module Adapters
 */

/**
 * @interface CacheAdapter
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9DYWNoZS9DYWNoZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsiQ2FjaGVBZGFwdGVyIiwiZ2V0Iiwia2V5IiwicHV0IiwidmFsdWUiLCJ0dGwiLCJkZWwiLCJjbGVhciIsInByZWZpeCJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBOztBQUNBO0FBQ0E7QUFDQTs7QUFDQTtBQUNBO0FBQ0E7QUFDTyxNQUFNQSxZQUFOLENBQW1CO0FBQ3hCO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDRUMsRUFBQUEsR0FBRyxDQUFDQyxHQUFELEVBQU0sQ0FBRTtBQUVYO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0VDLEVBQUFBLEdBQUcsQ0FBQ0QsR0FBRCxFQUFNRSxLQUFOLEVBQWFDLEdBQWIsRUFBa0IsQ0FBRTtBQUV2QjtBQUNGO0FBQ0E7QUFDQTs7O0FBQ0VDLEVBQUFBLEdBQUcsQ0FBQ0osR0FBRCxFQUFNLENBQUU7QUFFWDtBQUNGO0FBQ0E7QUFDQTs7O0FBQ0VLLEVBQUFBLEtBQUssQ0FBQ0MsTUFBRCxFQUFTLENBQUU7O0FBMUJRIiwic291cmNlc0NvbnRlbnQiOlsiLyplc2xpbnQgbm8tdW51c2VkLXZhcnM6IFwib2ZmXCIqL1xuLyoqXG4gKiBAbW9kdWxlIEFkYXB0ZXJzXG4gKi9cbi8qKlxuICogQGludGVyZmFjZSBDYWNoZUFkYXB0ZXJcbiAqL1xuZXhwb3J0IGNsYXNzIENhY2hlQWRhcHRlciB7XG4gIC8qKlxuICAgKiBHZXQgYSB2YWx1ZSBpbiB0aGUgY2FjaGVcbiAgICogQHBhcmFtIHtTdHJpbmd9IGtleSBDYWNoZSBrZXkgdG8gZ2V0XG4gICAqIEByZXR1cm4ge1Byb21pc2V9IHRoYXQgd2lsbCBldmVudHVhbGx5IHJlc29sdmUgdG8gdGhlIHZhbHVlIGluIHRoZSBjYWNoZS5cbiAgICovXG4gIGdldChrZXkpIHt9XG5cbiAgLyoqXG4gICAqIFNldCBhIHZhbHVlIGluIHRoZSBjYWNoZVxuICAgKiBAcGFyYW0ge1N0cmluZ30ga2V5IENhY2hlIGtleSB0byBzZXRcbiAgICogQHBhcmFtIHtTdHJpbmd9IHZhbHVlIFZhbHVlIHRvIHNldCB0aGUga2V5XG4gICAqIEBwYXJhbSB7U3RyaW5nfSB0dGwgT3B0aW9uYWwgVFRMXG4gICAqL1xuICBwdXQoa2V5LCB2YWx1ZSwgdHRsKSB7fVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgYSB2YWx1ZSBmcm9tIHRoZSBjYWNoZS5cbiAgICogQHBhcmFtIHtTdHJpbmd9IGtleSBDYWNoZSBrZXkgdG8gcmVtb3ZlXG4gICAqL1xuICBkZWwoa2V5KSB7fVxuXG4gIC8qKlxuICAgKiBFbXB0eSBhIGNhY2hlXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBwcmVmaXggQ2FjaGUga2V5IHByZWZpeCB0byByZW1vdmVcbiAgICovXG4gIGNsZWFyKHByZWZpeCkge31cbn1cbiJdfQ==