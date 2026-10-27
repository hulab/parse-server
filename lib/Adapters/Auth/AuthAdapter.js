"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.AuthAdapter = void 0;
/* eslint-disable unused-imports/no-unused-vars */

/**
 * @interface ParseAuthResponse
 * @property {Boolean} [doNotSave] If true, Parse Server will not save provided authData.
 * @property {Object} [response] If set, Parse Server will send the provided response to the client under authDataResponse
 * @property {Object} [save] If set, Parse Server will save the object provided into this key, instead of client provided authData
 */

/**
 * AuthPolicy
 * default: can be combined with ONE additional auth provider if additional configured on user
 * additional: could be only used with a default policy auth provider
 * solo: Will ignore ALL additional providers if additional configured on user
 * @typedef {"default" | "additional" | "solo"} AuthPolicy
 */

class AuthAdapter {
  constructor() {
    /**
     * Usage policy
     * @type {AuthPolicy}
     */
    if (!this.policy) {
      this.policy = 'default';
    }
  }
  /**
   * @param appIds The specified app IDs in the configuration
   * @param {Object} authData The client provided authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {(Promise<undefined|void>|void|undefined)} resolves or returns if the applicationId is valid
   */
  validateAppId(appIds, authData, options, request) {
    return Promise.resolve({});
  }

  /**
   * Legacy usage, if provided it will be triggered when authData related to this provider is touched (signup/update/login)
   * otherwise you should implement validateSetup, validateLogin and validateUpdate
   * @param {Object} authData The client provided authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<ParseAuthResponse|void|undefined>}
   */
  validateAuthData(authData, options, request) {
    return Promise.resolve({});
  }

  /**
   * Triggered when user provide for the first time this auth provider
   * could be a register or the user adding a new auth service
   * @param {Object} authData The client provided authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<ParseAuthResponse|void|undefined>}
   */
  validateSetUp(authData, options, req) {
    return Promise.resolve({});
  }

  /**
   * Triggered when user provide authData related to this provider
   * The user logs in and has already set this provider before
   * @param {Object} authData The client provided authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<ParseAuthResponse|void|undefined>}
   */
  validateLogin(authData, options, req) {
    return Promise.resolve({});
  }

  /**
   * Triggered when user provide authData related to this provider
   * the user or master key updates the authData and the user has already set this provider before
   * @param {Object} authData The client provided authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<ParseAuthResponse|void|undefined>}
   */
  validateUpdate(authData, options, req) {
    return Promise.resolve({});
  }

  /**
   * Triggered when user is looked up by authData with this provider. Override the `id` field if needed.
   * @param {Object} authData The client provided authData
   */
  beforeFind(authData) {}

  /**
   * Triggered in pre authentication process if needed (like webauthn, SMS OTP)
   * @param {Object} challengeData Data provided by the client
   * @param {(Object|undefined)} authData Auth data provided by the client, can be used for validation
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<Object>} A promise that resolves, resolved value will be added to challenge response under challenge key
   */
  challenge(challengeData, authData, options, request) {
    return Promise.resolve({});
  }

  /**
   * Triggered when auth data is fetched
   * @param {Object} authData authData
   * @param {Object} options additional adapter options
   * @param {Parse.Cloud.TriggerRequest} request
   * @returns {Promise<Object>} Any overrides required to authData
   */
  afterFind(authData, options, request) {
    return Promise.resolve({});
  }

  /**
   * Triggered when the adapter is first attached to Parse Server
   * @param {Object} options Adapter Options
   */
  validateOptions(options) {
    /* */
  }
}
exports.AuthAdapter = AuthAdapter;
var _default = exports.default = AuthAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJBdXRoQWRhcHRlciIsImNvbnN0cnVjdG9yIiwicG9saWN5IiwidmFsaWRhdGVBcHBJZCIsImFwcElkcyIsImF1dGhEYXRhIiwib3B0aW9ucyIsInJlcXVlc3QiLCJQcm9taXNlIiwicmVzb2x2ZSIsInZhbGlkYXRlQXV0aERhdGEiLCJ2YWxpZGF0ZVNldFVwIiwicmVxIiwidmFsaWRhdGVMb2dpbiIsInZhbGlkYXRlVXBkYXRlIiwiYmVmb3JlRmluZCIsImNoYWxsZW5nZSIsImNoYWxsZW5nZURhdGEiLCJhZnRlckZpbmQiLCJ2YWxpZGF0ZU9wdGlvbnMiLCJleHBvcnRzIiwiX2RlZmF1bHQiLCJkZWZhdWx0Il0sInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL0FkYXB0ZXJzL0F1dGgvQXV0aEFkYXB0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgdW51c2VkLWltcG9ydHMvbm8tdW51c2VkLXZhcnMgKi9cblxuLyoqXG4gKiBAaW50ZXJmYWNlIFBhcnNlQXV0aFJlc3BvbnNlXG4gKiBAcHJvcGVydHkge0Jvb2xlYW59IFtkb05vdFNhdmVdIElmIHRydWUsIFBhcnNlIFNlcnZlciB3aWxsIG5vdCBzYXZlIHByb3ZpZGVkIGF1dGhEYXRhLlxuICogQHByb3BlcnR5IHtPYmplY3R9IFtyZXNwb25zZV0gSWYgc2V0LCBQYXJzZSBTZXJ2ZXIgd2lsbCBzZW5kIHRoZSBwcm92aWRlZCByZXNwb25zZSB0byB0aGUgY2xpZW50IHVuZGVyIGF1dGhEYXRhUmVzcG9uc2VcbiAqIEBwcm9wZXJ0eSB7T2JqZWN0fSBbc2F2ZV0gSWYgc2V0LCBQYXJzZSBTZXJ2ZXIgd2lsbCBzYXZlIHRoZSBvYmplY3QgcHJvdmlkZWQgaW50byB0aGlzIGtleSwgaW5zdGVhZCBvZiBjbGllbnQgcHJvdmlkZWQgYXV0aERhdGFcbiAqL1xuXG4vKipcbiAqIEF1dGhQb2xpY3lcbiAqIGRlZmF1bHQ6IGNhbiBiZSBjb21iaW5lZCB3aXRoIE9ORSBhZGRpdGlvbmFsIGF1dGggcHJvdmlkZXIgaWYgYWRkaXRpb25hbCBjb25maWd1cmVkIG9uIHVzZXJcbiAqIGFkZGl0aW9uYWw6IGNvdWxkIGJlIG9ubHkgdXNlZCB3aXRoIGEgZGVmYXVsdCBwb2xpY3kgYXV0aCBwcm92aWRlclxuICogc29sbzogV2lsbCBpZ25vcmUgQUxMIGFkZGl0aW9uYWwgcHJvdmlkZXJzIGlmIGFkZGl0aW9uYWwgY29uZmlndXJlZCBvbiB1c2VyXG4gKiBAdHlwZWRlZiB7XCJkZWZhdWx0XCIgfCBcImFkZGl0aW9uYWxcIiB8IFwic29sb1wifSBBdXRoUG9saWN5XG4gKi9cblxuZXhwb3J0IGNsYXNzIEF1dGhBZGFwdGVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgLyoqXG4gICAgICogVXNhZ2UgcG9saWN5XG4gICAgICogQHR5cGUge0F1dGhQb2xpY3l9XG4gICAgICovXG4gICAgaWYgKCF0aGlzLnBvbGljeSkge1xuICAgICAgdGhpcy5wb2xpY3kgPSAnZGVmYXVsdCc7XG4gICAgfVxuICB9XG4gIC8qKlxuICAgKiBAcGFyYW0gYXBwSWRzIFRoZSBzcGVjaWZpZWQgYXBwIElEcyBpbiB0aGUgY29uZmlndXJhdGlvblxuICAgKiBAcGFyYW0ge09iamVjdH0gYXV0aERhdGEgVGhlIGNsaWVudCBwcm92aWRlZCBhdXRoRGF0YVxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyBhZGRpdGlvbmFsIGFkYXB0ZXIgb3B0aW9uc1xuICAgKiBAcGFyYW0ge1BhcnNlLkNsb3VkLlRyaWdnZXJSZXF1ZXN0fSByZXF1ZXN0XG4gICAqIEByZXR1cm5zIHsoUHJvbWlzZTx1bmRlZmluZWR8dm9pZD58dm9pZHx1bmRlZmluZWQpfSByZXNvbHZlcyBvciByZXR1cm5zIGlmIHRoZSBhcHBsaWNhdGlvbklkIGlzIHZhbGlkXG4gICAqL1xuICB2YWxpZGF0ZUFwcElkKGFwcElkcywgYXV0aERhdGEsIG9wdGlvbnMsIHJlcXVlc3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMZWdhY3kgdXNhZ2UsIGlmIHByb3ZpZGVkIGl0IHdpbGwgYmUgdHJpZ2dlcmVkIHdoZW4gYXV0aERhdGEgcmVsYXRlZCB0byB0aGlzIHByb3ZpZGVyIGlzIHRvdWNoZWQgKHNpZ251cC91cGRhdGUvbG9naW4pXG4gICAqIG90aGVyd2lzZSB5b3Ugc2hvdWxkIGltcGxlbWVudCB2YWxpZGF0ZVNldHVwLCB2YWxpZGF0ZUxvZ2luIGFuZCB2YWxpZGF0ZVVwZGF0ZVxuICAgKiBAcGFyYW0ge09iamVjdH0gYXV0aERhdGEgVGhlIGNsaWVudCBwcm92aWRlZCBhdXRoRGF0YVxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyBhZGRpdGlvbmFsIGFkYXB0ZXIgb3B0aW9uc1xuICAgKiBAcGFyYW0ge1BhcnNlLkNsb3VkLlRyaWdnZXJSZXF1ZXN0fSByZXF1ZXN0XG4gICAqIEByZXR1cm5zIHtQcm9taXNlPFBhcnNlQXV0aFJlc3BvbnNlfHZvaWR8dW5kZWZpbmVkPn1cbiAgICovXG4gIHZhbGlkYXRlQXV0aERhdGEoYXV0aERhdGEsIG9wdGlvbnMsIHJlcXVlc3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUcmlnZ2VyZWQgd2hlbiB1c2VyIHByb3ZpZGUgZm9yIHRoZSBmaXJzdCB0aW1lIHRoaXMgYXV0aCBwcm92aWRlclxuICAgKiBjb3VsZCBiZSBhIHJlZ2lzdGVyIG9yIHRoZSB1c2VyIGFkZGluZyBhIG5ldyBhdXRoIHNlcnZpY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGF1dGhEYXRhIFRoZSBjbGllbnQgcHJvdmlkZWQgYXV0aERhdGFcbiAgICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgYWRkaXRpb25hbCBhZGFwdGVyIG9wdGlvbnNcbiAgICogQHBhcmFtIHtQYXJzZS5DbG91ZC5UcmlnZ2VyUmVxdWVzdH0gcmVxdWVzdFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxQYXJzZUF1dGhSZXNwb25zZXx2b2lkfHVuZGVmaW5lZD59XG4gICAqL1xuICB2YWxpZGF0ZVNldFVwKGF1dGhEYXRhLCBvcHRpb25zLCByZXEpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUcmlnZ2VyZWQgd2hlbiB1c2VyIHByb3ZpZGUgYXV0aERhdGEgcmVsYXRlZCB0byB0aGlzIHByb3ZpZGVyXG4gICAqIFRoZSB1c2VyIGxvZ3MgaW4gYW5kIGhhcyBhbHJlYWR5IHNldCB0aGlzIHByb3ZpZGVyIGJlZm9yZVxuICAgKiBAcGFyYW0ge09iamVjdH0gYXV0aERhdGEgVGhlIGNsaWVudCBwcm92aWRlZCBhdXRoRGF0YVxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyBhZGRpdGlvbmFsIGFkYXB0ZXIgb3B0aW9uc1xuICAgKiBAcGFyYW0ge1BhcnNlLkNsb3VkLlRyaWdnZXJSZXF1ZXN0fSByZXF1ZXN0XG4gICAqIEByZXR1cm5zIHtQcm9taXNlPFBhcnNlQXV0aFJlc3BvbnNlfHZvaWR8dW5kZWZpbmVkPn1cbiAgICovXG4gIHZhbGlkYXRlTG9naW4oYXV0aERhdGEsIG9wdGlvbnMsIHJlcSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICB9XG5cbiAgLyoqXG4gICAqIFRyaWdnZXJlZCB3aGVuIHVzZXIgcHJvdmlkZSBhdXRoRGF0YSByZWxhdGVkIHRvIHRoaXMgcHJvdmlkZXJcbiAgICogdGhlIHVzZXIgb3IgbWFzdGVyIGtleSB1cGRhdGVzIHRoZSBhdXRoRGF0YSBhbmQgdGhlIHVzZXIgaGFzIGFscmVhZHkgc2V0IHRoaXMgcHJvdmlkZXIgYmVmb3JlXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBhdXRoRGF0YSBUaGUgY2xpZW50IHByb3ZpZGVkIGF1dGhEYXRhXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIGFkZGl0aW9uYWwgYWRhcHRlciBvcHRpb25zXG4gICAqIEBwYXJhbSB7UGFyc2UuQ2xvdWQuVHJpZ2dlclJlcXVlc3R9IHJlcXVlc3RcbiAgICogQHJldHVybnMge1Byb21pc2U8UGFyc2VBdXRoUmVzcG9uc2V8dm9pZHx1bmRlZmluZWQ+fVxuICAgKi9cbiAgdmFsaWRhdGVVcGRhdGUoYXV0aERhdGEsIG9wdGlvbnMsIHJlcSkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICB9XG5cbiAgLyoqXG4gICAqIFRyaWdnZXJlZCB3aGVuIHVzZXIgaXMgbG9va2VkIHVwIGJ5IGF1dGhEYXRhIHdpdGggdGhpcyBwcm92aWRlci4gT3ZlcnJpZGUgdGhlIGBpZGAgZmllbGQgaWYgbmVlZGVkLlxuICAgKiBAcGFyYW0ge09iamVjdH0gYXV0aERhdGEgVGhlIGNsaWVudCBwcm92aWRlZCBhdXRoRGF0YVxuICAgKi9cbiAgYmVmb3JlRmluZChhdXRoRGF0YSkge1xuXG4gIH1cblxuICAvKipcbiAgICogVHJpZ2dlcmVkIGluIHByZSBhdXRoZW50aWNhdGlvbiBwcm9jZXNzIGlmIG5lZWRlZCAobGlrZSB3ZWJhdXRobiwgU01TIE9UUClcbiAgICogQHBhcmFtIHtPYmplY3R9IGNoYWxsZW5nZURhdGEgRGF0YSBwcm92aWRlZCBieSB0aGUgY2xpZW50XG4gICAqIEBwYXJhbSB7KE9iamVjdHx1bmRlZmluZWQpfSBhdXRoRGF0YSBBdXRoIGRhdGEgcHJvdmlkZWQgYnkgdGhlIGNsaWVudCwgY2FuIGJlIHVzZWQgZm9yIHZhbGlkYXRpb25cbiAgICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgYWRkaXRpb25hbCBhZGFwdGVyIG9wdGlvbnNcbiAgICogQHBhcmFtIHtQYXJzZS5DbG91ZC5UcmlnZ2VyUmVxdWVzdH0gcmVxdWVzdFxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSBBIHByb21pc2UgdGhhdCByZXNvbHZlcywgcmVzb2x2ZWQgdmFsdWUgd2lsbCBiZSBhZGRlZCB0byBjaGFsbGVuZ2UgcmVzcG9uc2UgdW5kZXIgY2hhbGxlbmdlIGtleVxuICAgKi9cbiAgY2hhbGxlbmdlKGNoYWxsZW5nZURhdGEsIGF1dGhEYXRhLCBvcHRpb25zLCByZXF1ZXN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cblxuICAvKipcbiAgICogVHJpZ2dlcmVkIHdoZW4gYXV0aCBkYXRhIGlzIGZldGNoZWRcbiAgICogQHBhcmFtIHtPYmplY3R9IGF1dGhEYXRhIGF1dGhEYXRhXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIGFkZGl0aW9uYWwgYWRhcHRlciBvcHRpb25zXG4gICAqIEBwYXJhbSB7UGFyc2UuQ2xvdWQuVHJpZ2dlclJlcXVlc3R9IHJlcXVlc3RcbiAgICogQHJldHVybnMge1Byb21pc2U8T2JqZWN0Pn0gQW55IG92ZXJyaWRlcyByZXF1aXJlZCB0byBhdXRoRGF0YVxuICAgKi9cbiAgYWZ0ZXJGaW5kKGF1dGhEYXRhLCBvcHRpb25zLCByZXF1ZXN0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cblxuICAvKipcbiAgICogVHJpZ2dlcmVkIHdoZW4gdGhlIGFkYXB0ZXIgaXMgZmlyc3QgYXR0YWNoZWQgdG8gUGFyc2UgU2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIEFkYXB0ZXIgT3B0aW9uc1xuICAgKi9cbiAgdmFsaWRhdGVPcHRpb25zKG9wdGlvbnMpIHtcbiAgICAvKiAqL1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IEF1dGhBZGFwdGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRU8sTUFBTUEsV0FBVyxDQUFDO0VBQ3ZCQyxXQUFXQSxDQUFBLEVBQUc7SUFDWjtBQUNKO0FBQ0E7QUFDQTtJQUNJLElBQUksQ0FBQyxJQUFJLENBQUNDLE1BQU0sRUFBRTtNQUNoQixJQUFJLENBQUNBLE1BQU0sR0FBRyxTQUFTO0lBQ3pCO0VBQ0Y7RUFDQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFQyxhQUFhQSxDQUFDQyxNQUFNLEVBQUVDLFFBQVEsRUFBRUMsT0FBTyxFQUFFQyxPQUFPLEVBQUU7SUFDaEQsT0FBT0MsT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFQyxnQkFBZ0JBLENBQUNMLFFBQVEsRUFBRUMsT0FBTyxFQUFFQyxPQUFPLEVBQUU7SUFDM0MsT0FBT0MsT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFRSxhQUFhQSxDQUFDTixRQUFRLEVBQUVDLE9BQU8sRUFBRU0sR0FBRyxFQUFFO0lBQ3BDLE9BQU9KLE9BQU8sQ0FBQ0MsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0VBQzVCOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRUksYUFBYUEsQ0FBQ1IsUUFBUSxFQUFFQyxPQUFPLEVBQUVNLEdBQUcsRUFBRTtJQUNwQyxPQUFPSixPQUFPLENBQUNDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztFQUM1Qjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0VLLGNBQWNBLENBQUNULFFBQVEsRUFBRUMsT0FBTyxFQUFFTSxHQUFHLEVBQUU7SUFDckMsT0FBT0osT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7RUFDRU0sVUFBVUEsQ0FBQ1YsUUFBUSxFQUFFLENBRXJCOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRVcsU0FBU0EsQ0FBQ0MsYUFBYSxFQUFFWixRQUFRLEVBQUVDLE9BQU8sRUFBRUMsT0FBTyxFQUFFO0lBQ25ELE9BQU9DLE9BQU8sQ0FBQ0MsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO0VBQzVCOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0VTLFNBQVNBLENBQUNiLFFBQVEsRUFBRUMsT0FBTyxFQUFFQyxPQUFPLEVBQUU7SUFDcEMsT0FBT0MsT0FBTyxDQUFDQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7RUFDRVUsZUFBZUEsQ0FBQ2IsT0FBTyxFQUFFO0lBQ3ZCO0VBQUE7QUFFSjtBQUFDYyxPQUFBLENBQUFwQixXQUFBLEdBQUFBLFdBQUE7QUFBQSxJQUFBcUIsUUFBQSxHQUFBRCxPQUFBLENBQUFFLE9BQUEsR0FFY3RCLFdBQVciLCJpZ25vcmVMaXN0IjpbXX0=