'use strict';

var _request = require('request');

var _request2 = _interopRequireDefault(_request);

var _HTTPResponse = require('./HTTPResponse');

var _HTTPResponse2 = _interopRequireDefault(_HTTPResponse);

var _querystring = require('querystring');

var _querystring2 = _interopRequireDefault(_querystring);

var _logger = require('../logger');

var _logger2 = _interopRequireDefault(_logger);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var encodeBody = function ({ body, headers = {} }) {
  if (typeof body !== 'object') {
    return { body, headers };
  }
  var contentTypeKeys = Object.keys(headers).filter(key => {
    return key.match(/content-type/i) != null;
  });

  if (contentTypeKeys.length == 0) {
    // no content type
    //  As per https://parse.com/docs/cloudcode/guide#cloud-code-advanced-sending-a-post-request the default encoding is supposedly x-www-form-urlencoded

    body = _querystring2.default.stringify(body);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else {
    /* istanbul ignore next */
    if (contentTypeKeys.length > 1) {
      _logger2.default.error('Parse.Cloud.httpRequest', 'multiple content-type headers are set.');
    }
    // There maybe many, we'll just take the 1st one
    var contentType = contentTypeKeys[0];
    if (headers[contentType].match(/application\/json/i)) {
      body = JSON.stringify(body);
    } else if (headers[contentType].match(/application\/x-www-form-urlencoded/i)) {
      body = _querystring2.default.stringify(body);
    }
  }
  return { body, headers };
};

/**
 * Makes an HTTP Request.
 *
 * **Available in Cloud Code only.**
 *
 * By default, Parse.Cloud.httpRequest does not follow redirects caused by HTTP 3xx response codes. You can use the followRedirects option in the {@link Parse.Cloud.HTTPOptions} object to change this behavior.
 *
 * Sample request:
 * ```
 * Parse.Cloud.httpRequest({
 *   url: 'http://www.parse.com/'
 * }).then(function(httpResponse) {
 *   // success
 *   console.log(httpResponse.text);
 * },function(httpResponse) {
 *   // error
 *   console.error('Request failed with response code ' + httpResponse.status);
 * });
 * ```
 *
 * @method httpRequest
 * @name Parse.Cloud.httpRequest
 * @param {Parse.Cloud.HTTPOptions} options The Parse.Cloud.HTTPOptions object that makes the request.
 * @return {Promise<Parse.Cloud.HTTPResponse>} A promise that will be resolved with a {@link Parse.Cloud.HTTPResponse} object when the request completes.
 */
module.exports = function (options) {
  var callbacks = {
    success: options.success,
    error: options.error
  };
  delete options.success;
  delete options.error;
  delete options.uri; // not supported
  options = Object.assign(options, encodeBody(options));
  // set follow redirects to false by default
  options.followRedirect = options.followRedirects == true;
  // support params options
  if (typeof options.params === 'object') {
    options.qs = options.params;
  } else if (typeof options.params === 'string') {
    options.qs = _querystring2.default.parse(options.params);
  }
  // force the response as a buffer
  options.encoding = null;
  return new Promise((resolve, reject) => {
    (0, _request2.default)(options, (error, response, body) => {
      if (error) {
        if (callbacks.error) {
          callbacks.error(error);
        }
        return reject(error);
      }
      const httpResponse = new _HTTPResponse2.default(response, body);

      // Consider <200 && >= 400 as errors
      if (httpResponse.status < 200 || httpResponse.status >= 400) {
        if (callbacks.error) {
          callbacks.error(httpResponse);
        }
        return reject(httpResponse);
      } else {
        if (callbacks.success) {
          callbacks.success(httpResponse);
        }
        return resolve(httpResponse);
      }
    });
  });
};

/**
 * @typedef Parse.Cloud.HTTPOptions
 * @property {String|Object} body The body of the request. If it is a JSON object, then the Content-Type set in the headers must be application/x-www-form-urlencoded or application/json. You can also set this to a {@link Buffer} object to send raw bytes. If you use a Buffer, you should also set the Content-Type header explicitly to describe what these bytes represent.
 * @property {function} error The function that is called when the request fails. It will be passed a Parse.Cloud.HTTPResponse object.
 * @property {Boolean} followRedirects Whether to follow redirects caused by HTTP 3xx responses. Defaults to false.
 * @property {Object} headers The headers for the request.
 * @property {String} method The method of the request. GET, POST, PUT, DELETE, HEAD, and OPTIONS are supported. Will default to GET if not specified.
 * @property {String|Object} params The query portion of the url. You can pass a JSON object of key value pairs like params: {q : 'Sean Plott'} or a raw string like params:q=Sean Plott.
 * @property {function} success The function that is called when the request successfully completes. It will be passed a Parse.Cloud.HTTPResponse object.
 * @property {string} url The url to send the request to.
 */

module.exports.encodeBody = encodeBody;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9jbG91ZC1jb2RlL2h0dHBSZXF1ZXN0LmpzIl0sIm5hbWVzIjpbImVuY29kZUJvZHkiLCJib2R5IiwiaGVhZGVycyIsImNvbnRlbnRUeXBlS2V5cyIsIk9iamVjdCIsImtleXMiLCJmaWx0ZXIiLCJrZXkiLCJtYXRjaCIsImxlbmd0aCIsInF1ZXJ5c3RyaW5nIiwic3RyaW5naWZ5IiwibG9nIiwiZXJyb3IiLCJjb250ZW50VHlwZSIsIkpTT04iLCJtb2R1bGUiLCJleHBvcnRzIiwib3B0aW9ucyIsImNhbGxiYWNrcyIsInN1Y2Nlc3MiLCJ1cmkiLCJhc3NpZ24iLCJmb2xsb3dSZWRpcmVjdCIsImZvbGxvd1JlZGlyZWN0cyIsInBhcmFtcyIsInFzIiwicGFyc2UiLCJlbmNvZGluZyIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVqZWN0IiwicmVzcG9uc2UiLCJodHRwUmVzcG9uc2UiLCJIVFRQUmVzcG9uc2UiLCJzdGF0dXMiXSwibWFwcGluZ3MiOiI7O0FBQUE7Ozs7QUFDQTs7OztBQUNBOzs7O0FBQ0E7Ozs7OztBQUVBLElBQUlBLGFBQWEsVUFBUyxFQUFDQyxJQUFELEVBQU9DLFVBQVUsRUFBakIsRUFBVCxFQUErQjtBQUM5QyxNQUFJLE9BQU9ELElBQVAsS0FBZ0IsUUFBcEIsRUFBOEI7QUFDNUIsV0FBTyxFQUFDQSxJQUFELEVBQU9DLE9BQVAsRUFBUDtBQUNEO0FBQ0QsTUFBSUMsa0JBQWtCQyxPQUFPQyxJQUFQLENBQVlILE9BQVosRUFBcUJJLE1BQXJCLENBQTZCQyxHQUFELElBQVM7QUFDekQsV0FBT0EsSUFBSUMsS0FBSixDQUFVLGVBQVYsS0FBOEIsSUFBckM7QUFDRCxHQUZxQixDQUF0Qjs7QUFJQSxNQUFJTCxnQkFBZ0JNLE1BQWhCLElBQTBCLENBQTlCLEVBQWlDO0FBQy9CO0FBQ0E7O0FBRUFSLFdBQU9TLHNCQUFZQyxTQUFaLENBQXNCVixJQUF0QixDQUFQO0FBQ0FDLFlBQVEsY0FBUixJQUEwQixtQ0FBMUI7QUFDRCxHQU5ELE1BTU87QUFDTDtBQUNBLFFBQUlDLGdCQUFnQk0sTUFBaEIsR0FBeUIsQ0FBN0IsRUFBZ0M7QUFDOUJHLHVCQUFJQyxLQUFKLENBQVUseUJBQVYsRUFBcUMsd0NBQXJDO0FBQ0Q7QUFDRDtBQUNBLFFBQUlDLGNBQWNYLGdCQUFnQixDQUFoQixDQUFsQjtBQUNBLFFBQUlELFFBQVFZLFdBQVIsRUFBcUJOLEtBQXJCLENBQTJCLG9CQUEzQixDQUFKLEVBQXNEO0FBQ3BEUCxhQUFPYyxLQUFLSixTQUFMLENBQWVWLElBQWYsQ0FBUDtBQUNELEtBRkQsTUFFTyxJQUFHQyxRQUFRWSxXQUFSLEVBQXFCTixLQUFyQixDQUEyQixxQ0FBM0IsQ0FBSCxFQUFzRTtBQUMzRVAsYUFBT1Msc0JBQVlDLFNBQVosQ0FBc0JWLElBQXRCLENBQVA7QUFDRDtBQUNGO0FBQ0QsU0FBTyxFQUFDQSxJQUFELEVBQU9DLE9BQVAsRUFBUDtBQUNELENBNUJEOztBQThCQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXlCQWMsT0FBT0MsT0FBUCxHQUFpQixVQUFTQyxPQUFULEVBQWtCO0FBQ2pDLE1BQUlDLFlBQVk7QUFDZEMsYUFBU0YsUUFBUUUsT0FESDtBQUVkUCxXQUFPSyxRQUFRTDtBQUZELEdBQWhCO0FBSUEsU0FBT0ssUUFBUUUsT0FBZjtBQUNBLFNBQU9GLFFBQVFMLEtBQWY7QUFDQSxTQUFPSyxRQUFRRyxHQUFmLENBUGlDLENBT2I7QUFDcEJILFlBQVVkLE9BQU9rQixNQUFQLENBQWNKLE9BQWQsRUFBd0JsQixXQUFXa0IsT0FBWCxDQUF4QixDQUFWO0FBQ0E7QUFDQUEsVUFBUUssY0FBUixHQUF5QkwsUUFBUU0sZUFBUixJQUEyQixJQUFwRDtBQUNBO0FBQ0EsTUFBSSxPQUFPTixRQUFRTyxNQUFmLEtBQTBCLFFBQTlCLEVBQXdDO0FBQ3RDUCxZQUFRUSxFQUFSLEdBQWFSLFFBQVFPLE1BQXJCO0FBQ0QsR0FGRCxNQUVPLElBQUksT0FBT1AsUUFBUU8sTUFBZixLQUEwQixRQUE5QixFQUF3QztBQUM3Q1AsWUFBUVEsRUFBUixHQUFhaEIsc0JBQVlpQixLQUFaLENBQWtCVCxRQUFRTyxNQUExQixDQUFiO0FBQ0Q7QUFDRDtBQUNBUCxVQUFRVSxRQUFSLEdBQW1CLElBQW5CO0FBQ0EsU0FBTyxJQUFJQyxPQUFKLENBQVksQ0FBQ0MsT0FBRCxFQUFVQyxNQUFWLEtBQXFCO0FBQ3RDLDJCQUFRYixPQUFSLEVBQWlCLENBQUNMLEtBQUQsRUFBUW1CLFFBQVIsRUFBa0IvQixJQUFsQixLQUEyQjtBQUMxQyxVQUFJWSxLQUFKLEVBQVc7QUFDVCxZQUFJTSxVQUFVTixLQUFkLEVBQXFCO0FBQ25CTSxvQkFBVU4sS0FBVixDQUFnQkEsS0FBaEI7QUFDRDtBQUNELGVBQU9rQixPQUFPbEIsS0FBUCxDQUFQO0FBQ0Q7QUFDRCxZQUFNb0IsZUFBZSxJQUFJQyxzQkFBSixDQUFpQkYsUUFBakIsRUFBMkIvQixJQUEzQixDQUFyQjs7QUFFQTtBQUNBLFVBQUlnQyxhQUFhRSxNQUFiLEdBQXNCLEdBQXRCLElBQTZCRixhQUFhRSxNQUFiLElBQXVCLEdBQXhELEVBQTZEO0FBQzNELFlBQUloQixVQUFVTixLQUFkLEVBQXFCO0FBQ25CTSxvQkFBVU4sS0FBVixDQUFnQm9CLFlBQWhCO0FBQ0Q7QUFDRCxlQUFPRixPQUFPRSxZQUFQLENBQVA7QUFDRCxPQUxELE1BS087QUFDTCxZQUFJZCxVQUFVQyxPQUFkLEVBQXVCO0FBQ3JCRCxvQkFBVUMsT0FBVixDQUFrQmEsWUFBbEI7QUFDRDtBQUNELGVBQU9ILFFBQVFHLFlBQVIsQ0FBUDtBQUNEO0FBQ0YsS0FyQkQ7QUFzQkQsR0F2Qk0sQ0FBUDtBQXdCRCxDQTNDRDs7QUE2Q0E7Ozs7Ozs7Ozs7OztBQVlBakIsT0FBT0MsT0FBUCxDQUFlakIsVUFBZixHQUE0QkEsVUFBNUIiLCJmaWxlIjoiaHR0cFJlcXVlc3QuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgcmVxdWVzdCBmcm9tICdyZXF1ZXN0JztcbmltcG9ydCBIVFRQUmVzcG9uc2UgZnJvbSAnLi9IVFRQUmVzcG9uc2UnO1xuaW1wb3J0IHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJztcbmltcG9ydCBsb2cgZnJvbSAnLi4vbG9nZ2VyJztcblxudmFyIGVuY29kZUJvZHkgPSBmdW5jdGlvbih7Ym9keSwgaGVhZGVycyA9IHt9fSkge1xuICBpZiAodHlwZW9mIGJvZHkgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIHtib2R5LCBoZWFkZXJzfTtcbiAgfVxuICB2YXIgY29udGVudFR5cGVLZXlzID0gT2JqZWN0LmtleXMoaGVhZGVycykuZmlsdGVyKChrZXkpID0+IHtcbiAgICByZXR1cm4ga2V5Lm1hdGNoKC9jb250ZW50LXR5cGUvaSkgIT0gbnVsbDtcbiAgfSk7XG5cbiAgaWYgKGNvbnRlbnRUeXBlS2V5cy5sZW5ndGggPT0gMCkge1xuICAgIC8vIG5vIGNvbnRlbnQgdHlwZVxuICAgIC8vICBBcyBwZXIgaHR0cHM6Ly9wYXJzZS5jb20vZG9jcy9jbG91ZGNvZGUvZ3VpZGUjY2xvdWQtY29kZS1hZHZhbmNlZC1zZW5kaW5nLWEtcG9zdC1yZXF1ZXN0IHRoZSBkZWZhdWx0IGVuY29kaW5nIGlzIHN1cHBvc2VkbHkgeC13d3ctZm9ybS11cmxlbmNvZGVkXG5cbiAgICBib2R5ID0gcXVlcnlzdHJpbmcuc3RyaW5naWZ5KGJvZHkpO1xuICAgIGhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZCc7XG4gIH0gZWxzZSB7XG4gICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICBpZiAoY29udGVudFR5cGVLZXlzLmxlbmd0aCA+IDEpIHtcbiAgICAgIGxvZy5lcnJvcignUGFyc2UuQ2xvdWQuaHR0cFJlcXVlc3QnLCAnbXVsdGlwbGUgY29udGVudC10eXBlIGhlYWRlcnMgYXJlIHNldC4nKTtcbiAgICB9XG4gICAgLy8gVGhlcmUgbWF5YmUgbWFueSwgd2UnbGwganVzdCB0YWtlIHRoZSAxc3Qgb25lXG4gICAgdmFyIGNvbnRlbnRUeXBlID0gY29udGVudFR5cGVLZXlzWzBdO1xuICAgIGlmIChoZWFkZXJzW2NvbnRlbnRUeXBlXS5tYXRjaCgvYXBwbGljYXRpb25cXC9qc29uL2kpKSB7XG4gICAgICBib2R5ID0gSlNPTi5zdHJpbmdpZnkoYm9keSk7XG4gICAgfSBlbHNlIGlmKGhlYWRlcnNbY29udGVudFR5cGVdLm1hdGNoKC9hcHBsaWNhdGlvblxcL3gtd3d3LWZvcm0tdXJsZW5jb2RlZC9pKSkge1xuICAgICAgYm9keSA9IHF1ZXJ5c3RyaW5nLnN0cmluZ2lmeShib2R5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHtib2R5LCBoZWFkZXJzfTtcbn1cblxuLyoqXG4gKiBNYWtlcyBhbiBIVFRQIFJlcXVlc3QuXG4gKlxuICogKipBdmFpbGFibGUgaW4gQ2xvdWQgQ29kZSBvbmx5LioqXG4gKlxuICogQnkgZGVmYXVsdCwgUGFyc2UuQ2xvdWQuaHR0cFJlcXVlc3QgZG9lcyBub3QgZm9sbG93IHJlZGlyZWN0cyBjYXVzZWQgYnkgSFRUUCAzeHggcmVzcG9uc2UgY29kZXMuIFlvdSBjYW4gdXNlIHRoZSBmb2xsb3dSZWRpcmVjdHMgb3B0aW9uIGluIHRoZSB7QGxpbmsgUGFyc2UuQ2xvdWQuSFRUUE9wdGlvbnN9IG9iamVjdCB0byBjaGFuZ2UgdGhpcyBiZWhhdmlvci5cbiAqXG4gKiBTYW1wbGUgcmVxdWVzdDpcbiAqIGBgYFxuICogUGFyc2UuQ2xvdWQuaHR0cFJlcXVlc3Qoe1xuICogICB1cmw6ICdodHRwOi8vd3d3LnBhcnNlLmNvbS8nXG4gKiB9KS50aGVuKGZ1bmN0aW9uKGh0dHBSZXNwb25zZSkge1xuICogICAvLyBzdWNjZXNzXG4gKiAgIGNvbnNvbGUubG9nKGh0dHBSZXNwb25zZS50ZXh0KTtcbiAqIH0sZnVuY3Rpb24oaHR0cFJlc3BvbnNlKSB7XG4gKiAgIC8vIGVycm9yXG4gKiAgIGNvbnNvbGUuZXJyb3IoJ1JlcXVlc3QgZmFpbGVkIHdpdGggcmVzcG9uc2UgY29kZSAnICsgaHR0cFJlc3BvbnNlLnN0YXR1cyk7XG4gKiB9KTtcbiAqIGBgYFxuICpcbiAqIEBtZXRob2QgaHR0cFJlcXVlc3RcbiAqIEBuYW1lIFBhcnNlLkNsb3VkLmh0dHBSZXF1ZXN0XG4gKiBAcGFyYW0ge1BhcnNlLkNsb3VkLkhUVFBPcHRpb25zfSBvcHRpb25zIFRoZSBQYXJzZS5DbG91ZC5IVFRQT3B0aW9ucyBvYmplY3QgdGhhdCBtYWtlcyB0aGUgcmVxdWVzdC5cbiAqIEByZXR1cm4ge1Byb21pc2U8UGFyc2UuQ2xvdWQuSFRUUFJlc3BvbnNlPn0gQSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aXRoIGEge0BsaW5rIFBhcnNlLkNsb3VkLkhUVFBSZXNwb25zZX0gb2JqZWN0IHdoZW4gdGhlIHJlcXVlc3QgY29tcGxldGVzLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKG9wdGlvbnMpIHtcbiAgdmFyIGNhbGxiYWNrcyA9IHtcbiAgICBzdWNjZXNzOiBvcHRpb25zLnN1Y2Nlc3MsXG4gICAgZXJyb3I6IG9wdGlvbnMuZXJyb3JcbiAgfTtcbiAgZGVsZXRlIG9wdGlvbnMuc3VjY2VzcztcbiAgZGVsZXRlIG9wdGlvbnMuZXJyb3I7XG4gIGRlbGV0ZSBvcHRpb25zLnVyaTsgLy8gbm90IHN1cHBvcnRlZFxuICBvcHRpb25zID0gT2JqZWN0LmFzc2lnbihvcHRpb25zLCAgZW5jb2RlQm9keShvcHRpb25zKSk7XG4gIC8vIHNldCBmb2xsb3cgcmVkaXJlY3RzIHRvIGZhbHNlIGJ5IGRlZmF1bHRcbiAgb3B0aW9ucy5mb2xsb3dSZWRpcmVjdCA9IG9wdGlvbnMuZm9sbG93UmVkaXJlY3RzID09IHRydWU7XG4gIC8vIHN1cHBvcnQgcGFyYW1zIG9wdGlvbnNcbiAgaWYgKHR5cGVvZiBvcHRpb25zLnBhcmFtcyA9PT0gJ29iamVjdCcpIHtcbiAgICBvcHRpb25zLnFzID0gb3B0aW9ucy5wYXJhbXM7XG4gIH0gZWxzZSBpZiAodHlwZW9mIG9wdGlvbnMucGFyYW1zID09PSAnc3RyaW5nJykge1xuICAgIG9wdGlvbnMucXMgPSBxdWVyeXN0cmluZy5wYXJzZShvcHRpb25zLnBhcmFtcyk7XG4gIH1cbiAgLy8gZm9yY2UgdGhlIHJlc3BvbnNlIGFzIGEgYnVmZmVyXG4gIG9wdGlvbnMuZW5jb2RpbmcgPSBudWxsO1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHJlcXVlc3Qob3B0aW9ucywgKGVycm9yLCByZXNwb25zZSwgYm9keSkgPT4ge1xuICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgIGlmIChjYWxsYmFja3MuZXJyb3IpIHtcbiAgICAgICAgICBjYWxsYmFja3MuZXJyb3IoZXJyb3IpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZWplY3QoZXJyb3IpO1xuICAgICAgfVxuICAgICAgY29uc3QgaHR0cFJlc3BvbnNlID0gbmV3IEhUVFBSZXNwb25zZShyZXNwb25zZSwgYm9keSk7XG5cbiAgICAgIC8vIENvbnNpZGVyIDwyMDAgJiYgPj0gNDAwIGFzIGVycm9yc1xuICAgICAgaWYgKGh0dHBSZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgaHR0cFJlc3BvbnNlLnN0YXR1cyA+PSA0MDApIHtcbiAgICAgICAgaWYgKGNhbGxiYWNrcy5lcnJvcikge1xuICAgICAgICAgIGNhbGxiYWNrcy5lcnJvcihodHRwUmVzcG9uc2UpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZWplY3QoaHR0cFJlc3BvbnNlKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChjYWxsYmFja3Muc3VjY2Vzcykge1xuICAgICAgICAgIGNhbGxiYWNrcy5zdWNjZXNzKGh0dHBSZXNwb25zZSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc29sdmUoaHR0cFJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG59O1xuXG4vKipcbiAqIEB0eXBlZGVmIFBhcnNlLkNsb3VkLkhUVFBPcHRpb25zXG4gKiBAcHJvcGVydHkge1N0cmluZ3xPYmplY3R9IGJvZHkgVGhlIGJvZHkgb2YgdGhlIHJlcXVlc3QuIElmIGl0IGlzIGEgSlNPTiBvYmplY3QsIHRoZW4gdGhlIENvbnRlbnQtVHlwZSBzZXQgaW4gdGhlIGhlYWRlcnMgbXVzdCBiZSBhcHBsaWNhdGlvbi94LXd3dy1mb3JtLXVybGVuY29kZWQgb3IgYXBwbGljYXRpb24vanNvbi4gWW91IGNhbiBhbHNvIHNldCB0aGlzIHRvIGEge0BsaW5rIEJ1ZmZlcn0gb2JqZWN0IHRvIHNlbmQgcmF3IGJ5dGVzLiBJZiB5b3UgdXNlIGEgQnVmZmVyLCB5b3Ugc2hvdWxkIGFsc28gc2V0IHRoZSBDb250ZW50LVR5cGUgaGVhZGVyIGV4cGxpY2l0bHkgdG8gZGVzY3JpYmUgd2hhdCB0aGVzZSBieXRlcyByZXByZXNlbnQuXG4gKiBAcHJvcGVydHkge2Z1bmN0aW9ufSBlcnJvciBUaGUgZnVuY3Rpb24gdGhhdCBpcyBjYWxsZWQgd2hlbiB0aGUgcmVxdWVzdCBmYWlscy4gSXQgd2lsbCBiZSBwYXNzZWQgYSBQYXJzZS5DbG91ZC5IVFRQUmVzcG9uc2Ugb2JqZWN0LlxuICogQHByb3BlcnR5IHtCb29sZWFufSBmb2xsb3dSZWRpcmVjdHMgV2hldGhlciB0byBmb2xsb3cgcmVkaXJlY3RzIGNhdXNlZCBieSBIVFRQIDN4eCByZXNwb25zZXMuIERlZmF1bHRzIHRvIGZhbHNlLlxuICogQHByb3BlcnR5IHtPYmplY3R9IGhlYWRlcnMgVGhlIGhlYWRlcnMgZm9yIHRoZSByZXF1ZXN0LlxuICogQHByb3BlcnR5IHtTdHJpbmd9IG1ldGhvZCBUaGUgbWV0aG9kIG9mIHRoZSByZXF1ZXN0LiBHRVQsIFBPU1QsIFBVVCwgREVMRVRFLCBIRUFELCBhbmQgT1BUSU9OUyBhcmUgc3VwcG9ydGVkLiBXaWxsIGRlZmF1bHQgdG8gR0VUIGlmIG5vdCBzcGVjaWZpZWQuXG4gKiBAcHJvcGVydHkge1N0cmluZ3xPYmplY3R9IHBhcmFtcyBUaGUgcXVlcnkgcG9ydGlvbiBvZiB0aGUgdXJsLiBZb3UgY2FuIHBhc3MgYSBKU09OIG9iamVjdCBvZiBrZXkgdmFsdWUgcGFpcnMgbGlrZSBwYXJhbXM6IHtxIDogJ1NlYW4gUGxvdHQnfSBvciBhIHJhdyBzdHJpbmcgbGlrZSBwYXJhbXM6cT1TZWFuIFBsb3R0LlxuICogQHByb3BlcnR5IHtmdW5jdGlvbn0gc3VjY2VzcyBUaGUgZnVuY3Rpb24gdGhhdCBpcyBjYWxsZWQgd2hlbiB0aGUgcmVxdWVzdCBzdWNjZXNzZnVsbHkgY29tcGxldGVzLiBJdCB3aWxsIGJlIHBhc3NlZCBhIFBhcnNlLkNsb3VkLkhUVFBSZXNwb25zZSBvYmplY3QuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdXJsIFRoZSB1cmwgdG8gc2VuZCB0aGUgcmVxdWVzdCB0by5cbiAqL1xuXG5tb2R1bGUuZXhwb3J0cy5lbmNvZGVCb2R5ID0gZW5jb2RlQm9keTtcbiJdfQ==