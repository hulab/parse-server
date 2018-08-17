'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

/**
 * @module Adapters
 */
/**
 * @interface FilesAdapter
 */
class FilesAdapter {

  /** Responsible for storing the file in order to be retrieved later by its filename
   *
   * @param {string} filename - the filename to save
   * @param {*} data - the buffer of data from the file
   * @param {string} contentType - the supposed contentType
   * @discussion the contentType can be undefined if the controller was not able to determine it
   *
   * @return {Promise} a promise that should fail if the storage didn't succeed
   */
  createFile(filename, data, contentType) {}

  /** Responsible for deleting the specified file
   *
   * @param {string} filename - the filename to delete
   *
   * @return {Promise} a promise that should fail if the deletion didn't succeed
   */
  deleteFile(filename) {}

  /** Responsible for retrieving the data of the specified file
   *
   * @param {string} filename - the name of file to retrieve
   *
   * @return {Promise} a promise that should pass with the file data or fail on error
   */
  getFileData(filename) {}

  /** Returns an absolute URL where the file can be accessed
   *
   * @param {Config} config - server configuration
   * @param {string} filename
   *
   * @return {string} Absolute URL
   */
  getFileLocation(config, filename) {}
}

exports.FilesAdapter = FilesAdapter; /*eslint no-unused-vars: "off"*/
// Files Adapter
//
// Allows you to change the file storage mechanism.
//
// Adapter classes must implement the following functions:
// * createFile(filename, data, contentType)
// * deleteFile(filename)
// * getFileData(filename)
// * getFileLocation(config, filename)
//
// Default is GridStoreAdapter, which requires mongo
// and for the API server to be using the DatabaseController with Mongo
// database adapter.

exports.default = FilesAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9GaWxlcy9GaWxlc0FkYXB0ZXIuanMiXSwibmFtZXMiOlsiRmlsZXNBZGFwdGVyIiwiY3JlYXRlRmlsZSIsImZpbGVuYW1lIiwiZGF0YSIsImNvbnRlbnRUeXBlIiwiZGVsZXRlRmlsZSIsImdldEZpbGVEYXRhIiwiZ2V0RmlsZUxvY2F0aW9uIiwiY29uZmlnIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFnQkE7OztBQUdBOzs7QUFHTyxNQUFNQSxZQUFOLENBQW1COztBQUV4Qjs7Ozs7Ozs7O0FBU0FDLGFBQVdDLFFBQVgsRUFBNkJDLElBQTdCLEVBQW1DQyxXQUFuQyxFQUFpRSxDQUFHOztBQUVwRTs7Ozs7O0FBTUFDLGFBQVdILFFBQVgsRUFBc0MsQ0FBRzs7QUFFekM7Ozs7OztBQU1BSSxjQUFZSixRQUFaLEVBQTRDLENBQUc7O0FBRS9DOzs7Ozs7O0FBT0FLLGtCQUFnQkMsTUFBaEIsRUFBZ0NOLFFBQWhDLEVBQTBELENBQUc7QUFwQ3JDOztRQUFiRixZLEdBQUFBLFksRUF0QmI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7a0JBZ0RlQSxZIiwiZmlsZSI6IkZpbGVzQWRhcHRlci5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qZXNsaW50IG5vLXVudXNlZC12YXJzOiBcIm9mZlwiKi9cbi8vIEZpbGVzIEFkYXB0ZXJcbi8vXG4vLyBBbGxvd3MgeW91IHRvIGNoYW5nZSB0aGUgZmlsZSBzdG9yYWdlIG1lY2hhbmlzbS5cbi8vXG4vLyBBZGFwdGVyIGNsYXNzZXMgbXVzdCBpbXBsZW1lbnQgdGhlIGZvbGxvd2luZyBmdW5jdGlvbnM6XG4vLyAqIGNyZWF0ZUZpbGUoZmlsZW5hbWUsIGRhdGEsIGNvbnRlbnRUeXBlKVxuLy8gKiBkZWxldGVGaWxlKGZpbGVuYW1lKVxuLy8gKiBnZXRGaWxlRGF0YShmaWxlbmFtZSlcbi8vICogZ2V0RmlsZUxvY2F0aW9uKGNvbmZpZywgZmlsZW5hbWUpXG4vL1xuLy8gRGVmYXVsdCBpcyBHcmlkU3RvcmVBZGFwdGVyLCB3aGljaCByZXF1aXJlcyBtb25nb1xuLy8gYW5kIGZvciB0aGUgQVBJIHNlcnZlciB0byBiZSB1c2luZyB0aGUgRGF0YWJhc2VDb250cm9sbGVyIHdpdGggTW9uZ29cbi8vIGRhdGFiYXNlIGFkYXB0ZXIuXG5cbmltcG9ydCB0eXBlIHsgQ29uZmlnIH0gZnJvbSAnLi4vLi4vQ29uZmlnJ1xuLyoqXG4gKiBAbW9kdWxlIEFkYXB0ZXJzXG4gKi9cbi8qKlxuICogQGludGVyZmFjZSBGaWxlc0FkYXB0ZXJcbiAqL1xuZXhwb3J0IGNsYXNzIEZpbGVzQWRhcHRlciB7XG5cbiAgLyoqIFJlc3BvbnNpYmxlIGZvciBzdG9yaW5nIHRoZSBmaWxlIGluIG9yZGVyIHRvIGJlIHJldHJpZXZlZCBsYXRlciBieSBpdHMgZmlsZW5hbWVcbiAgICpcbiAgICogQHBhcmFtIHtzdHJpbmd9IGZpbGVuYW1lIC0gdGhlIGZpbGVuYW1lIHRvIHNhdmVcbiAgICogQHBhcmFtIHsqfSBkYXRhIC0gdGhlIGJ1ZmZlciBvZiBkYXRhIGZyb20gdGhlIGZpbGVcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRlbnRUeXBlIC0gdGhlIHN1cHBvc2VkIGNvbnRlbnRUeXBlXG4gICAqIEBkaXNjdXNzaW9uIHRoZSBjb250ZW50VHlwZSBjYW4gYmUgdW5kZWZpbmVkIGlmIHRoZSBjb250cm9sbGVyIHdhcyBub3QgYWJsZSB0byBkZXRlcm1pbmUgaXRcbiAgICpcbiAgICogQHJldHVybiB7UHJvbWlzZX0gYSBwcm9taXNlIHRoYXQgc2hvdWxkIGZhaWwgaWYgdGhlIHN0b3JhZ2UgZGlkbid0IHN1Y2NlZWRcbiAgICovXG4gIGNyZWF0ZUZpbGUoZmlsZW5hbWU6IHN0cmluZywgZGF0YSwgY29udGVudFR5cGU6IHN0cmluZyk6IFByb21pc2UgeyB9XG5cbiAgLyoqIFJlc3BvbnNpYmxlIGZvciBkZWxldGluZyB0aGUgc3BlY2lmaWVkIGZpbGVcbiAgICpcbiAgICogQHBhcmFtIHtzdHJpbmd9IGZpbGVuYW1lIC0gdGhlIGZpbGVuYW1lIHRvIGRlbGV0ZVxuICAgKlxuICAgKiBAcmV0dXJuIHtQcm9taXNlfSBhIHByb21pc2UgdGhhdCBzaG91bGQgZmFpbCBpZiB0aGUgZGVsZXRpb24gZGlkbid0IHN1Y2NlZWRcbiAgICovXG4gIGRlbGV0ZUZpbGUoZmlsZW5hbWU6IHN0cmluZyk6IFByb21pc2UgeyB9XG5cbiAgLyoqIFJlc3BvbnNpYmxlIGZvciByZXRyaWV2aW5nIHRoZSBkYXRhIG9mIHRoZSBzcGVjaWZpZWQgZmlsZVxuICAgKlxuICAgKiBAcGFyYW0ge3N0cmluZ30gZmlsZW5hbWUgLSB0aGUgbmFtZSBvZiBmaWxlIHRvIHJldHJpZXZlXG4gICAqXG4gICAqIEByZXR1cm4ge1Byb21pc2V9IGEgcHJvbWlzZSB0aGF0IHNob3VsZCBwYXNzIHdpdGggdGhlIGZpbGUgZGF0YSBvciBmYWlsIG9uIGVycm9yXG4gICAqL1xuICBnZXRGaWxlRGF0YShmaWxlbmFtZTogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHsgfVxuXG4gIC8qKiBSZXR1cm5zIGFuIGFic29sdXRlIFVSTCB3aGVyZSB0aGUgZmlsZSBjYW4gYmUgYWNjZXNzZWRcbiAgICpcbiAgICogQHBhcmFtIHtDb25maWd9IGNvbmZpZyAtIHNlcnZlciBjb25maWd1cmF0aW9uXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBmaWxlbmFtZVxuICAgKlxuICAgKiBAcmV0dXJuIHtzdHJpbmd9IEFic29sdXRlIFVSTFxuICAgKi9cbiAgZ2V0RmlsZUxvY2F0aW9uKGNvbmZpZzogQ29uZmlnLCBmaWxlbmFtZTogc3RyaW5nKTogc3RyaW5nIHsgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBGaWxlc0FkYXB0ZXI7XG4iXX0=