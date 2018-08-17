"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});

/*eslint no-unused-vars: "off"*/
// Push Adapter
//
// Allows you to change the push notification mechanism.
//
// Adapter classes must implement the following functions:
// * getValidPushTypes()
// * send(devices, installations, pushStatus)
//
// Default is ParsePushAdapter, which uses GCM for
// android push and APNS for ios push.

/**
 * @module Adapters
 */
/**
 * @interface PushAdapter
 */
class PushAdapter {
  /**
   * @param {any} body
   * @param {Parse.Installation[]} installations
   * @param {any} pushStatus
   * @returns {Promise}
   */
  send(body, installations, pushStatus) {}

  /**
   * Get an array of valid push types.
   * @returns {Array} An array of valid push types
   */
  getValidPushTypes() {
    return [];
  }
}

exports.PushAdapter = PushAdapter;
exports.default = PushAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9QdXNoL1B1c2hBZGFwdGVyLmpzIl0sIm5hbWVzIjpbIlB1c2hBZGFwdGVyIiwic2VuZCIsImJvZHkiLCJpbnN0YWxsYXRpb25zIiwicHVzaFN0YXR1cyIsImdldFZhbGlkUHVzaFR5cGVzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBOzs7QUFHQTs7O0FBR08sTUFBTUEsV0FBTixDQUFrQjtBQUN2Qjs7Ozs7O0FBTUFDLE9BQUtDLElBQUwsRUFBZ0JDLGFBQWhCLEVBQXNDQyxVQUF0QyxFQUFvRSxDQUFFOztBQUV0RTs7OztBQUlBQyxzQkFBOEI7QUFDNUIsV0FBTyxFQUFQO0FBQ0Q7QUFmc0I7O1FBQVpMLFcsR0FBQUEsVztrQkFrQkVBLFciLCJmaWxlIjoiUHVzaEFkYXB0ZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuLyplc2xpbnQgbm8tdW51c2VkLXZhcnM6IFwib2ZmXCIqL1xuLy8gUHVzaCBBZGFwdGVyXG4vL1xuLy8gQWxsb3dzIHlvdSB0byBjaGFuZ2UgdGhlIHB1c2ggbm90aWZpY2F0aW9uIG1lY2hhbmlzbS5cbi8vXG4vLyBBZGFwdGVyIGNsYXNzZXMgbXVzdCBpbXBsZW1lbnQgdGhlIGZvbGxvd2luZyBmdW5jdGlvbnM6XG4vLyAqIGdldFZhbGlkUHVzaFR5cGVzKClcbi8vICogc2VuZChkZXZpY2VzLCBpbnN0YWxsYXRpb25zLCBwdXNoU3RhdHVzKVxuLy9cbi8vIERlZmF1bHQgaXMgUGFyc2VQdXNoQWRhcHRlciwgd2hpY2ggdXNlcyBHQ00gZm9yXG4vLyBhbmRyb2lkIHB1c2ggYW5kIEFQTlMgZm9yIGlvcyBwdXNoLlxuXG4vKipcbiAqIEBtb2R1bGUgQWRhcHRlcnNcbiAqL1xuLyoqXG4gKiBAaW50ZXJmYWNlIFB1c2hBZGFwdGVyXG4gKi9cbmV4cG9ydCBjbGFzcyBQdXNoQWRhcHRlciB7XG4gIC8qKlxuICAgKiBAcGFyYW0ge2FueX0gYm9keVxuICAgKiBAcGFyYW0ge1BhcnNlLkluc3RhbGxhdGlvbltdfSBpbnN0YWxsYXRpb25zXG4gICAqIEBwYXJhbSB7YW55fSBwdXNoU3RhdHVzXG4gICAqIEByZXR1cm5zIHtQcm9taXNlfVxuICAgKi9cbiAgc2VuZChib2R5OiBhbnksIGluc3RhbGxhdGlvbnM6IGFueVtdLCBwdXNoU3RhdHVzOiBhbnkpOiA/UHJvbWlzZTwqPiB7fVxuXG4gIC8qKlxuICAgKiBHZXQgYW4gYXJyYXkgb2YgdmFsaWQgcHVzaCB0eXBlcy5cbiAgICogQHJldHVybnMge0FycmF5fSBBbiBhcnJheSBvZiB2YWxpZCBwdXNoIHR5cGVzXG4gICAqL1xuICBnZXRWYWxpZFB1c2hUeXBlcygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIFtdXG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgUHVzaEFkYXB0ZXI7XG4iXX0=