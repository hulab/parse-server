"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
/*eslint no-unused-vars: "off"*/
/**
 * @module Adapters
 */
/**
 * @interface AnalyticsAdapter
 */
class AnalyticsAdapter {

  /**
  @param {any} parameters: the analytics request body, analytics info will be in the dimensions property
  @param {Request} req: the original http request
   */
  appOpened(parameters, req) {
    return Promise.resolve({});
  }

  /**
  @param {String} eventName: the name of the custom eventName
  @param {any} parameters: the analytics request body, analytics info will be in the dimensions property
  @param {Request} req: the original http request
   */
  trackEvent(eventName, parameters, req) {
    return Promise.resolve({});
  }
}

exports.AnalyticsAdapter = AnalyticsAdapter;
exports.default = AnalyticsAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9BbmFseXRpY3MvQW5hbHl0aWNzQWRhcHRlci5qcyJdLCJuYW1lcyI6WyJBbmFseXRpY3NBZGFwdGVyIiwiYXBwT3BlbmVkIiwicGFyYW1ldGVycyIsInJlcSIsIlByb21pc2UiLCJyZXNvbHZlIiwidHJhY2tFdmVudCIsImV2ZW50TmFtZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQTtBQUNBOzs7QUFHQTs7O0FBR08sTUFBTUEsZ0JBQU4sQ0FBdUI7O0FBRTVCOzs7O0FBSUFDLFlBQVVDLFVBQVYsRUFBc0JDLEdBQXRCLEVBQTJCO0FBQ3pCLFdBQU9DLFFBQVFDLE9BQVIsQ0FBZ0IsRUFBaEIsQ0FBUDtBQUNEOztBQUVEOzs7OztBQUtBQyxhQUFXQyxTQUFYLEVBQXNCTCxVQUF0QixFQUFrQ0MsR0FBbEMsRUFBdUM7QUFDckMsV0FBT0MsUUFBUUMsT0FBUixDQUFnQixFQUFoQixDQUFQO0FBQ0Q7QUFqQjJCOztRQUFqQkwsZ0IsR0FBQUEsZ0I7a0JBb0JFQSxnQiIsImZpbGUiOiJBbmFseXRpY3NBZGFwdGVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyplc2xpbnQgbm8tdW51c2VkLXZhcnM6IFwib2ZmXCIqL1xuLyoqXG4gKiBAbW9kdWxlIEFkYXB0ZXJzXG4gKi9cbi8qKlxuICogQGludGVyZmFjZSBBbmFseXRpY3NBZGFwdGVyXG4gKi9cbmV4cG9ydCBjbGFzcyBBbmFseXRpY3NBZGFwdGVyIHtcblxuICAvKipcbiAgQHBhcmFtIHthbnl9IHBhcmFtZXRlcnM6IHRoZSBhbmFseXRpY3MgcmVxdWVzdCBib2R5LCBhbmFseXRpY3MgaW5mbyB3aWxsIGJlIGluIHRoZSBkaW1lbnNpb25zIHByb3BlcnR5XG4gIEBwYXJhbSB7UmVxdWVzdH0gcmVxOiB0aGUgb3JpZ2luYWwgaHR0cCByZXF1ZXN0XG4gICAqL1xuICBhcHBPcGVuZWQocGFyYW1ldGVycywgcmVxKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cblxuICAvKipcbiAgQHBhcmFtIHtTdHJpbmd9IGV2ZW50TmFtZTogdGhlIG5hbWUgb2YgdGhlIGN1c3RvbSBldmVudE5hbWVcbiAgQHBhcmFtIHthbnl9IHBhcmFtZXRlcnM6IHRoZSBhbmFseXRpY3MgcmVxdWVzdCBib2R5LCBhbmFseXRpY3MgaW5mbyB3aWxsIGJlIGluIHRoZSBkaW1lbnNpb25zIHByb3BlcnR5XG4gIEBwYXJhbSB7UmVxdWVzdH0gcmVxOiB0aGUgb3JpZ2luYWwgaHR0cCByZXF1ZXN0XG4gICAqL1xuICB0cmFja0V2ZW50KGV2ZW50TmFtZSwgcGFyYW1ldGVycywgcmVxKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgQW5hbHl0aWNzQWRhcHRlcjtcbiJdfQ==