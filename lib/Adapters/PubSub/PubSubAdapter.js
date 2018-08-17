"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
/*eslint no-unused-vars: "off"*/
/**
 * @module Adapters
 */
/**
 * @interface PubSubAdapter
 */
class PubSubAdapter {
  /**
   * @returns {PubSubAdapter.Publisher}
   */
  static createPublisher() {}
  /**
   * @returns {PubSubAdapter.Subscriber}
   */
  static createSubscriber() {}
}

exports.PubSubAdapter = PubSubAdapter; /**
                                        * @interface Publisher
                                        * @memberof PubSubAdapter
                                        */


/**
 * @interface Subscriber
 * @memberof PubSubAdapter
 */

exports.default = PubSubAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9QdWJTdWIvUHViU3ViQWRhcHRlci5qcyJdLCJuYW1lcyI6WyJQdWJTdWJBZGFwdGVyIiwiY3JlYXRlUHVibGlzaGVyIiwiY3JlYXRlU3Vic2NyaWJlciJdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQTtBQUNBOzs7QUFHQTs7O0FBR08sTUFBTUEsYUFBTixDQUFvQjtBQUN6Qjs7O0FBR0EsU0FBT0MsZUFBUCxHQUF5QixDQUFFO0FBQzNCOzs7QUFHQSxTQUFPQyxnQkFBUCxHQUEwQixDQUFFO0FBUkg7O1FBQWRGLGEsR0FBQUEsYSxFQVdiOzs7Ozs7QUFZQTs7Ozs7a0JBa0JlQSxhIiwiZmlsZSI6IlB1YlN1YkFkYXB0ZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKmVzbGludCBuby11bnVzZWQtdmFyczogXCJvZmZcIiovXG4vKipcbiAqIEBtb2R1bGUgQWRhcHRlcnNcbiAqL1xuLyoqXG4gKiBAaW50ZXJmYWNlIFB1YlN1YkFkYXB0ZXJcbiAqL1xuZXhwb3J0IGNsYXNzIFB1YlN1YkFkYXB0ZXIge1xuICAvKipcbiAgICogQHJldHVybnMge1B1YlN1YkFkYXB0ZXIuUHVibGlzaGVyfVxuICAgKi9cbiAgc3RhdGljIGNyZWF0ZVB1Ymxpc2hlcigpIHt9XG4gIC8qKlxuICAgKiBAcmV0dXJucyB7UHViU3ViQWRhcHRlci5TdWJzY3JpYmVyfVxuICAgKi9cbiAgc3RhdGljIGNyZWF0ZVN1YnNjcmliZXIoKSB7fVxufVxuXG4vKipcbiAqIEBpbnRlcmZhY2UgUHVibGlzaGVyXG4gKiBAbWVtYmVyb2YgUHViU3ViQWRhcHRlclxuICovXG5pbnRlcmZhY2UgUHVibGlzaGVyIHtcbiAgLyoqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaGFubmVsIHRoZSBjaGFubmVsIGluIHdoaWNoIHRvIHB1Ymxpc2hcbiAgICogQHBhcmFtIHtTdHJpbmd9IG1lc3NhZ2UgdGhlIG1lc3NhZ2UgdG8gcHVibGlzaFxuICAgKi9cbiAgcHVibGlzaChjaGFubmVsOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZyk6dm9pZDtcbn1cblxuLyoqXG4gKiBAaW50ZXJmYWNlIFN1YnNjcmliZXJcbiAqIEBtZW1iZXJvZiBQdWJTdWJBZGFwdGVyXG4gKi9cbmludGVyZmFjZSBTdWJzY3JpYmVyIHtcbiAgLyoqXG4gICAqIGNhbGxlZCB3aGVuIGEgbmV3IHN1YnNjcmlwdGlvbiB0aGUgY2hhbm5lbCBpcyByZXF1aXJlZFxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2hhbm5lbCB0aGUgY2hhbm5lbCB0byBzdWJzY3JpYmVcbiAgICovXG4gIHN1YnNjcmliZShjaGFubmVsOiBzdHJpbmcpOiB2b2lkO1xuXG4gIC8qKlxuICAgKiBjYWxsZWQgd2hlbiB0aGUgc3Vic2NyaXB0aW9uIGZyb20gdGhlIGNoYW5uZWwgc2hvdWxkIGJlIHN0b3BwZWRcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNoYW5uZWxcbiAgICovXG4gIHVuc3Vic2NyaWJlKGNoYW5uZWw6IHN0cmluZyk6IHZvaWQ7XG59XG5cbmV4cG9ydCBkZWZhdWx0IFB1YlN1YkFkYXB0ZXI7XG4iXX0=