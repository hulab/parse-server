'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
/**
 * @typedef Parse.Cloud.HTTPResponse
 * @property {Buffer} buffer The raw byte representation of the response body. Use this to receive binary data. See Buffer for more details.
 * @property {Object} cookies The cookies sent by the server. The keys in this object are the names of the cookies. The values are Parse.Cloud.Cookie objects.
 * @property {Object} data The parsed response body as a JavaScript object. This is only available when the response Content-Type is application/x-www-form-urlencoded or application/json.
 * @property {Object} headers The headers sent by the server. The keys in this object are the names of the headers. We do not support multiple response headers with the same name. In the common case of Set-Cookie headers, please use the cookies field instead.
 * @property {Number} status The status code.
 * @property {String} text The raw text representation of the response body.
 */
class HTTPResponse {
  constructor(response, body) {
    let _text, _data;
    this.status = response.statusCode;
    this.headers = response.headers || {};
    this.cookies = this.headers["set-cookie"];

    if (typeof body == 'string') {
      _text = body;
    } else if (Buffer.isBuffer(body)) {
      this.buffer = body;
    } else if (typeof body == 'object') {
      _data = body;
    }

    const getText = () => {
      if (!_text && this.buffer) {
        _text = this.buffer.toString('utf-8');
      } else if (!_text && _data) {
        _text = JSON.stringify(_data);
      }
      return _text;
    };

    const getData = () => {
      if (!_data) {
        try {
          _data = JSON.parse(getText());
        } catch (e) {/* */}
      }
      return _data;
    };

    Object.defineProperty(this, 'body', {
      get: () => {
        return body;
      }
    });

    Object.defineProperty(this, 'text', {
      enumerable: true,
      get: getText
    });

    Object.defineProperty(this, 'data', {
      enumerable: true,
      get: getData
    });
  }
}
exports.default = HTTPResponse;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9jbG91ZC1jb2RlL0hUVFBSZXNwb25zZS5qcyJdLCJuYW1lcyI6WyJIVFRQUmVzcG9uc2UiLCJjb25zdHJ1Y3RvciIsInJlc3BvbnNlIiwiYm9keSIsIl90ZXh0IiwiX2RhdGEiLCJzdGF0dXMiLCJzdGF0dXNDb2RlIiwiaGVhZGVycyIsImNvb2tpZXMiLCJCdWZmZXIiLCJpc0J1ZmZlciIsImJ1ZmZlciIsImdldFRleHQiLCJ0b1N0cmluZyIsIkpTT04iLCJzdHJpbmdpZnkiLCJnZXREYXRhIiwicGFyc2UiLCJlIiwiT2JqZWN0IiwiZGVmaW5lUHJvcGVydHkiLCJnZXQiLCJlbnVtZXJhYmxlIl0sIm1hcHBpbmdzIjoiOzs7OztBQUFBOzs7Ozs7Ozs7QUFTZSxNQUFNQSxZQUFOLENBQW1CO0FBQ2hDQyxjQUFZQyxRQUFaLEVBQXNCQyxJQUF0QixFQUE0QjtBQUMxQixRQUFJQyxLQUFKLEVBQVdDLEtBQVg7QUFDQSxTQUFLQyxNQUFMLEdBQWNKLFNBQVNLLFVBQXZCO0FBQ0EsU0FBS0MsT0FBTCxHQUFlTixTQUFTTSxPQUFULElBQW9CLEVBQW5DO0FBQ0EsU0FBS0MsT0FBTCxHQUFlLEtBQUtELE9BQUwsQ0FBYSxZQUFiLENBQWY7O0FBRUEsUUFBSSxPQUFPTCxJQUFQLElBQWUsUUFBbkIsRUFBNkI7QUFDM0JDLGNBQVFELElBQVI7QUFDRCxLQUZELE1BRU8sSUFBSU8sT0FBT0MsUUFBUCxDQUFnQlIsSUFBaEIsQ0FBSixFQUEyQjtBQUNoQyxXQUFLUyxNQUFMLEdBQWNULElBQWQ7QUFDRCxLQUZNLE1BRUEsSUFBSSxPQUFPQSxJQUFQLElBQWUsUUFBbkIsRUFBNkI7QUFDbENFLGNBQVFGLElBQVI7QUFDRDs7QUFFRCxVQUFNVSxVQUFVLE1BQU07QUFDcEIsVUFBSSxDQUFDVCxLQUFELElBQVUsS0FBS1EsTUFBbkIsRUFBMkI7QUFDekJSLGdCQUFRLEtBQUtRLE1BQUwsQ0FBWUUsUUFBWixDQUFxQixPQUFyQixDQUFSO0FBQ0QsT0FGRCxNQUVPLElBQUksQ0FBQ1YsS0FBRCxJQUFVQyxLQUFkLEVBQXFCO0FBQzFCRCxnQkFBUVcsS0FBS0MsU0FBTCxDQUFlWCxLQUFmLENBQVI7QUFDRDtBQUNELGFBQU9ELEtBQVA7QUFDRCxLQVBEOztBQVNBLFVBQU1hLFVBQVUsTUFBTTtBQUNwQixVQUFJLENBQUNaLEtBQUwsRUFBWTtBQUNWLFlBQUk7QUFDRkEsa0JBQVFVLEtBQUtHLEtBQUwsQ0FBV0wsU0FBWCxDQUFSO0FBQ0QsU0FGRCxDQUVFLE9BQU9NLENBQVAsRUFBVSxDQUFFLEtBQU87QUFDdEI7QUFDRCxhQUFPZCxLQUFQO0FBQ0QsS0FQRDs7QUFTQWUsV0FBT0MsY0FBUCxDQUFzQixJQUF0QixFQUE0QixNQUE1QixFQUFvQztBQUNsQ0MsV0FBSyxNQUFNO0FBQUUsZUFBT25CLElBQVA7QUFBYTtBQURRLEtBQXBDOztBQUlBaUIsV0FBT0MsY0FBUCxDQUFzQixJQUF0QixFQUE0QixNQUE1QixFQUFvQztBQUNsQ0Usa0JBQVksSUFEc0I7QUFFbENELFdBQUtUO0FBRjZCLEtBQXBDOztBQUtBTyxXQUFPQyxjQUFQLENBQXNCLElBQXRCLEVBQTRCLE1BQTVCLEVBQW9DO0FBQ2xDRSxrQkFBWSxJQURzQjtBQUVsQ0QsV0FBS0w7QUFGNkIsS0FBcEM7QUFJRDtBQTlDK0I7a0JBQWJqQixZIiwiZmlsZSI6IkhUVFBSZXNwb25zZS5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQHR5cGVkZWYgUGFyc2UuQ2xvdWQuSFRUUFJlc3BvbnNlXG4gKiBAcHJvcGVydHkge0J1ZmZlcn0gYnVmZmVyIFRoZSByYXcgYnl0ZSByZXByZXNlbnRhdGlvbiBvZiB0aGUgcmVzcG9uc2UgYm9keS4gVXNlIHRoaXMgdG8gcmVjZWl2ZSBiaW5hcnkgZGF0YS4gU2VlIEJ1ZmZlciBmb3IgbW9yZSBkZXRhaWxzLlxuICogQHByb3BlcnR5IHtPYmplY3R9IGNvb2tpZXMgVGhlIGNvb2tpZXMgc2VudCBieSB0aGUgc2VydmVyLiBUaGUga2V5cyBpbiB0aGlzIG9iamVjdCBhcmUgdGhlIG5hbWVzIG9mIHRoZSBjb29raWVzLiBUaGUgdmFsdWVzIGFyZSBQYXJzZS5DbG91ZC5Db29raWUgb2JqZWN0cy5cbiAqIEBwcm9wZXJ0eSB7T2JqZWN0fSBkYXRhIFRoZSBwYXJzZWQgcmVzcG9uc2UgYm9keSBhcyBhIEphdmFTY3JpcHQgb2JqZWN0LiBUaGlzIGlzIG9ubHkgYXZhaWxhYmxlIHdoZW4gdGhlIHJlc3BvbnNlIENvbnRlbnQtVHlwZSBpcyBhcHBsaWNhdGlvbi94LXd3dy1mb3JtLXVybGVuY29kZWQgb3IgYXBwbGljYXRpb24vanNvbi5cbiAqIEBwcm9wZXJ0eSB7T2JqZWN0fSBoZWFkZXJzIFRoZSBoZWFkZXJzIHNlbnQgYnkgdGhlIHNlcnZlci4gVGhlIGtleXMgaW4gdGhpcyBvYmplY3QgYXJlIHRoZSBuYW1lcyBvZiB0aGUgaGVhZGVycy4gV2UgZG8gbm90IHN1cHBvcnQgbXVsdGlwbGUgcmVzcG9uc2UgaGVhZGVycyB3aXRoIHRoZSBzYW1lIG5hbWUuIEluIHRoZSBjb21tb24gY2FzZSBvZiBTZXQtQ29va2llIGhlYWRlcnMsIHBsZWFzZSB1c2UgdGhlIGNvb2tpZXMgZmllbGQgaW5zdGVhZC5cbiAqIEBwcm9wZXJ0eSB7TnVtYmVyfSBzdGF0dXMgVGhlIHN0YXR1cyBjb2RlLlxuICogQHByb3BlcnR5IHtTdHJpbmd9IHRleHQgVGhlIHJhdyB0ZXh0IHJlcHJlc2VudGF0aW9uIG9mIHRoZSByZXNwb25zZSBib2R5LlxuICovXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIVFRQUmVzcG9uc2Uge1xuICBjb25zdHJ1Y3RvcihyZXNwb25zZSwgYm9keSkge1xuICAgIGxldCBfdGV4dCwgX2RhdGE7XG4gICAgdGhpcy5zdGF0dXMgPSByZXNwb25zZS5zdGF0dXNDb2RlO1xuICAgIHRoaXMuaGVhZGVycyA9IHJlc3BvbnNlLmhlYWRlcnMgfHwge307XG4gICAgdGhpcy5jb29raWVzID0gdGhpcy5oZWFkZXJzW1wic2V0LWNvb2tpZVwiXTtcblxuICAgIGlmICh0eXBlb2YgYm9keSA9PSAnc3RyaW5nJykge1xuICAgICAgX3RleHQgPSBib2R5O1xuICAgIH0gZWxzZSBpZiAoQnVmZmVyLmlzQnVmZmVyKGJvZHkpKSB7XG4gICAgICB0aGlzLmJ1ZmZlciA9IGJvZHk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgYm9keSA9PSAnb2JqZWN0Jykge1xuICAgICAgX2RhdGEgPSBib2R5O1xuICAgIH1cblxuICAgIGNvbnN0IGdldFRleHQgPSAoKSA9PiB7XG4gICAgICBpZiAoIV90ZXh0ICYmIHRoaXMuYnVmZmVyKSB7XG4gICAgICAgIF90ZXh0ID0gdGhpcy5idWZmZXIudG9TdHJpbmcoJ3V0Zi04Jyk7XG4gICAgICB9IGVsc2UgaWYgKCFfdGV4dCAmJiBfZGF0YSkge1xuICAgICAgICBfdGV4dCA9IEpTT04uc3RyaW5naWZ5KF9kYXRhKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBfdGV4dDtcbiAgICB9XG5cbiAgICBjb25zdCBnZXREYXRhID0gKCkgPT4ge1xuICAgICAgaWYgKCFfZGF0YSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIF9kYXRhID0gSlNPTi5wYXJzZShnZXRUZXh0KCkpO1xuICAgICAgICB9IGNhdGNoIChlKSB7IC8qICovIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBfZGF0YTtcbiAgICB9XG5cbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgJ2JvZHknLCB7XG4gICAgICBnZXQ6ICgpID0+IHsgcmV0dXJuIGJvZHkgfVxuICAgIH0pO1xuXG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsICd0ZXh0Jywge1xuICAgICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICAgIGdldDogZ2V0VGV4dFxuICAgIH0pO1xuXG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsICdkYXRhJywge1xuICAgICAgZW51bWVyYWJsZTogdHJ1ZSxcbiAgICAgIGdldDogZ2V0RGF0YVxuICAgIH0pO1xuICB9XG59XG4iXX0=