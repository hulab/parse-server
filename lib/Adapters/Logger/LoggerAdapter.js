"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
/*eslint no-unused-vars: "off"*/
/**
 * @module Adapters
 */
/**
 * @interface LoggerAdapter
 * Logger Adapter
 * Allows you to change the logger mechanism
 * Default is WinstonLoggerAdapter.js
 */
class LoggerAdapter {
  constructor(options) {}
  /**
   * log
   * @param {String} level
   * @param {String} message
   * @param {Object} metadata
   */
  log(level, message) /* meta */{}
}

exports.LoggerAdapter = LoggerAdapter;
exports.default = LoggerAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9Mb2dnZXIvTG9nZ2VyQWRhcHRlci5qcyJdLCJuYW1lcyI6WyJMb2dnZXJBZGFwdGVyIiwiY29uc3RydWN0b3IiLCJvcHRpb25zIiwibG9nIiwibGV2ZWwiLCJtZXNzYWdlIl0sIm1hcHBpbmdzIjoiOzs7OztBQUFBO0FBQ0E7OztBQUdBOzs7Ozs7QUFNTyxNQUFNQSxhQUFOLENBQW9CO0FBQ3pCQyxjQUFZQyxPQUFaLEVBQXFCLENBQUU7QUFDdkI7Ozs7OztBQU1BQyxNQUFJQyxLQUFKLEVBQVdDLE9BQVgsRUFBb0IsVUFBWSxDQUFFO0FBUlQ7O1FBQWRMLGEsR0FBQUEsYTtrQkFXRUEsYSIsImZpbGUiOiJMb2dnZXJBZGFwdGVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyplc2xpbnQgbm8tdW51c2VkLXZhcnM6IFwib2ZmXCIqL1xuLyoqXG4gKiBAbW9kdWxlIEFkYXB0ZXJzXG4gKi9cbi8qKlxuICogQGludGVyZmFjZSBMb2dnZXJBZGFwdGVyXG4gKiBMb2dnZXIgQWRhcHRlclxuICogQWxsb3dzIHlvdSB0byBjaGFuZ2UgdGhlIGxvZ2dlciBtZWNoYW5pc21cbiAqIERlZmF1bHQgaXMgV2luc3RvbkxvZ2dlckFkYXB0ZXIuanNcbiAqL1xuZXhwb3J0IGNsYXNzIExvZ2dlckFkYXB0ZXIge1xuICBjb25zdHJ1Y3RvcihvcHRpb25zKSB7fVxuICAvKipcbiAgICogbG9nXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBsZXZlbFxuICAgKiBAcGFyYW0ge1N0cmluZ30gbWVzc2FnZVxuICAgKiBAcGFyYW0ge09iamVjdH0gbWV0YWRhdGFcbiAgICovXG4gIGxvZyhsZXZlbCwgbWVzc2FnZSwgLyogbWV0YSAqLykge31cbn1cblxuZXhwb3J0IGRlZmF1bHQgTG9nZ2VyQWRhcHRlcjtcbiJdfQ==