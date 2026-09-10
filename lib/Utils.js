"use strict";

/**
 * utils.js
 * @file General purpose utilities
 * @description General purpose utilities.
 */

const path = require('path');
const fs = require('fs').promises;
const {
  types
} = require('util');

/**
 * The general purpose utilities.
 */
class Utils {
  /**
   * @function getLocalizedPath
   * @description Returns a localized file path accoring to the locale.
   *
   * Localized files are searched in subfolders of a given path, e.g.
   *
   * root/
   * ├── base/                    // base path to files
   * │   ├── example.html         // default file
   * │   └── de/                  // de language folder
   * │   │   └── example.html     // de localized file
   * │   └── de-AT/               // de-AT locale folder
   * │   │   └── example.html     // de-AT localized file
   *
   * Files are matched with the locale in the following order:
   * 1. Locale match, e.g. locale `de-AT` matches file in folder `de-AT`.
   * 2. Language match, e.g. locale `de-AT` matches file in folder `de`.
   * 3. Default; file in base folder is returned.
   *
   * @param {String} defaultPath The absolute file path, which is also
   * the default path returned if localization is not available.
   * @param {String} locale The locale.
   * @returns {Promise<Object>} The object contains:
   * - `path`: The path to the localized file, or the original path if
   *   localization is not available.
   * - `subdir`: The subdirectory of the localized file, or undefined if
   *   there is no matching localized file.
   */
  static async getLocalizedPath(defaultPath, locale) {
    // Get file name and paths
    const file = path.basename(defaultPath);
    const basePath = path.dirname(defaultPath);

    // If locale is not set return default file
    if (!locale) {
      return {
        path: defaultPath
      };
    }

    // Check file for locale exists
    const localePath = path.join(basePath, locale, file);
    const localeFileExists = await Utils.fileExists(localePath);

    // If file for locale exists return file
    if (localeFileExists) {
      return {
        path: localePath,
        subdir: locale
      };
    }

    // Check file for language exists
    const language = locale.split('-')[0];
    const languagePath = path.join(basePath, language, file);
    const languageFileExists = await Utils.fileExists(languagePath);

    // If file for language exists return file
    if (languageFileExists) {
      return {
        path: languagePath,
        subdir: language
      };
    }

    // Return default file
    return {
      path: defaultPath
    };
  }

  /**
   * @function fileExists
   * @description Checks whether a file exists.
   * @param {String} path The file path.
   * @returns {Promise<Boolean>} Is true if the file can be accessed, false otherwise.
   */
  static async fileExists(path) {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @function isPath
   * @description Evaluates whether a string is a file path (as opposed to a URL for example).
   * @param {String} s The string to evaluate.
   * @returns {Boolean} Returns true if the evaluated string is a path.
   */
  static isPath(s) {
    return /(^\/)|(^\.\/)|(^\.\.\/)/.test(s);
  }

  /**
   * Flattens an object and crates new keys with custom delimiters.
   * @param {Object} obj The object to flatten.
   * @param {String} [delimiter='.'] The delimiter of the newly generated keys.
   * @param {Object} result
   * @returns {Object} The flattened object.
   **/
  static flattenObject(obj, parentKey, delimiter = '.', result = {}) {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const newKey = parentKey ? parentKey + delimiter + key : key;
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          this.flattenObject(obj[key], newKey, delimiter, result);
        } else {
          result[newKey] = obj[key];
        }
      }
    }
    return result;
  }

  /**
   * Realm-safe check for Date.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a Date.
   */
  static isDate(value) {
    return types.isDate(value);
  }

  /**
   * Realm-safe check for RegExp.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a RegExp.
   */
  static isRegExp(value) {
    return types.isRegExp(value);
  }

  /**
   * Realm-safe check for Map.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a Map.
   */
  static isMap(value) {
    return types.isMap(value);
  }

  /**
   * Realm-safe check for Set.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a Set.
   */
  static isSet(value) {
    return types.isSet(value);
  }

  /**
   * Realm-safe check for native Error.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a native Error.
   */
  static isNativeError(value) {
    return types.isNativeError(value);
  }

  /**
   * Realm-safe check for Promise (duck-typed as thenable).
   * Guards against Object.prototype pollution by ensuring `then` is not
   * inherited solely from Object.prototype.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a Promise or thenable.
   */
  static isPromise(value) {
    if (value == null || typeof value.then !== 'function') {
      return false;
    }
    return Object.getPrototypeOf(value) !== Object.prototype || Object.prototype.hasOwnProperty.call(value, 'then');
  }

  /**
   * Realm-safe check for object type. Uses `typeof` instead of `instanceof Object`
   * which fails across realms. Returns true for any non-null value where
   * `typeof` is `'object'`, including plain objects, arrays, dates, maps, sets,
   * regex, and boxed primitives (e.g. `new String()`). Returns false for `null`,
   * `undefined`, unboxed primitives, and functions.
   * @param {any} value The value to check.
   * @returns {Boolean} Returns true if the value is a non-null object type.
   */
  static isObject(value) {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Creates an object with all permutations of the original keys.
   * For example, this definition:
   * ```
   * {
   *   a: [true, false],
   *   b: [1, 2],
   *   c: ['x']
   * }
   * ```
   * permutates to:
   * ```
   * [
   *   { a: true, b: 1, c: 'x' },
   *   { a: true, b: 2, c: 'x' },
   *   { a: false, b: 1, c: 'x' },
   *   { a: false, b: 2, c: 'x' }
   * ]
   * ```
   * @param {Object} object The object to permutate.
   * @param {Integer} [index=0] The current key index.
   * @param {Object} [current={}] The current result entry being composed.
   * @param {Array} [results=[]] The resulting array of permutations.
   */
  static getObjectKeyPermutations(object, index = 0, current = {}, results = []) {
    const keys = Object.keys(object);
    const key = keys[index];
    const values = object[key];
    for (const value of values) {
      current[key] = value;
      const nextIndex = index + 1;
      if (nextIndex < keys.length) {
        Utils.getObjectKeyPermutations(object, nextIndex, current, results);
      } else {
        const result = Object.assign({}, current);
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Validates parameters and throws if a parameter is invalid.
   * Example parameter types syntax:
   * ```
   * {
   *   parameterName: {
   *      t: 'boolean',
   *      v: isBoolean,
   *      o: true
   *   },
   *   ...
   * }
   * ```
   * @param {Object} params The parameters to validate.
   * @param {Array<Object>} types The parameter types used for validation.
   * @param {Object} types.t The parameter type; used for error message, not for validation.
   * @param {Object} types.v The function to validate the parameter value.
   * @param {Boolean} [types.o=false] Is true if the parameter is optional.
   */
  static validateParams(params, types) {
    for (const key of Object.keys(params)) {
      const type = types[key];
      const isOptional = !!type.o;
      const param = params[key];
      if (!(isOptional && param == null) && !type.v(param)) {
        throw `Invalid parameter ${key} must be of type ${type.t} but is ${typeof param}`;
      }
    }
  }

  /**
   * Computes the relative date based on a string.
   * @param {String} text The string to interpret the date from.
   * @param {Date} now The date the string is comparing against.
   * @returns {Object} The relative date object.
   **/
  static relativeTimeToDate(text, now = new Date()) {
    text = text.toLowerCase();
    let parts = text.split(' ');

    // Filter out whitespace
    parts = parts.filter(part => part !== '');
    const future = parts[0] === 'in';
    const past = parts[parts.length - 1] === 'ago';
    if (!future && !past && text !== 'now') {
      return {
        status: 'error',
        info: "Time should either start with 'in' or end with 'ago'"
      };
    }
    if (future && past) {
      return {
        status: 'error',
        info: "Time cannot have both 'in' and 'ago'"
      };
    }

    // strip the 'ago' or 'in'
    if (future) {
      parts = parts.slice(1);
    } else {
      // past
      parts = parts.slice(0, parts.length - 1);
    }
    if (parts.length % 2 !== 0 && text !== 'now') {
      return {
        status: 'error',
        info: 'Invalid time string. Dangling unit or number.'
      };
    }
    const pairs = [];
    while (parts.length) {
      pairs.push([parts.shift(), parts.shift()]);
    }
    let seconds = 0;
    for (const [num, interval] of pairs) {
      const val = Number(num);
      if (!Number.isInteger(val)) {
        return {
          status: 'error',
          info: `'${num}' is not an integer.`
        };
      }
      switch (interval) {
        case 'yr':
        case 'yrs':
        case 'year':
        case 'years':
          seconds += val * 31536000; // 365 * 24 * 60 * 60
          break;
        case 'wk':
        case 'wks':
        case 'week':
        case 'weeks':
          seconds += val * 604800; // 7 * 24 * 60 * 60
          break;
        case 'd':
        case 'day':
        case 'days':
          seconds += val * 86400; // 24 * 60 * 60
          break;
        case 'hr':
        case 'hrs':
        case 'hour':
        case 'hours':
          seconds += val * 3600; // 60 * 60
          break;
        case 'min':
        case 'mins':
        case 'minute':
        case 'minutes':
          seconds += val * 60;
          break;
        case 'sec':
        case 'secs':
        case 'second':
        case 'seconds':
          seconds += val;
          break;
        default:
          return {
            status: 'error',
            info: `Invalid interval: '${interval}'`
          };
      }
    }
    const milliseconds = seconds * 1000;
    if (future) {
      return {
        status: 'success',
        info: 'future',
        result: new Date(now.valueOf() + milliseconds)
      };
    } else if (past) {
      return {
        status: 'success',
        info: 'past',
        result: new Date(now.valueOf() - milliseconds)
      };
    } else {
      return {
        status: 'success',
        info: 'present',
        result: new Date(now.valueOf())
      };
    }
  }

  /**
   * Deep-scans an object for a matching key/value definition.
   * @param {Object} obj The object to scan.
   * @param {String | undefined} key The key to match, or undefined if only the value should be matched.
   * @param {any | undefined} value The value to match, or undefined if only the key should be matched.
   * @returns {Boolean} True if a match was found, false otherwise.
   */
  static objectContainsKeyValue(obj, key, value) {
    const isMatch = (a, b) => typeof a === 'string' && new RegExp(b).test(a) || a === b;
    const isKeyMatch = k => isMatch(k, key);
    const isValueMatch = v => isMatch(v, value);
    const stack = [obj];
    const seen = new WeakSet();
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const [k, v] of Object.entries(current)) {
        if (key !== undefined && value === undefined && isKeyMatch(k)) {
          return true;
        } else if (key === undefined && value !== undefined && isValueMatch(v)) {
          return true;
        } else if (key !== undefined && value !== undefined && isKeyMatch(k) && isValueMatch(v)) {
          return true;
        }
        if (['[object Object]', '[object Array]'].includes(Object.prototype.toString.call(v))) {
          stack.push(v);
        }
      }
    }
    return false;
  }
  static checkProhibitedKeywords(config, data) {
    if (config?.requestKeywordDenylist) {
      // Scan request data for denied keywords
      for (const keyword of config.requestKeywordDenylist) {
        const match = Utils.objectContainsKeyValue(data, keyword.key, keyword.value);
        if (match) {
          throw `Prohibited keyword in request data: ${JSON.stringify(keyword)}.`;
        }
      }
    }
  }

  /**
   * Moves the nested keys of a specified key in an object to the root of the object.
   *
   * @param {Object} obj The object to modify.
   * @param {String} key The key whose nested keys will be moved to root.
   * @returns {Object} The modified object, or the original object if no modification happened.
   * @example
   * const obj = {
   *   a: 1,
   *   b: {
   *     c: 2,
   *     d: 3
   *   },
   *   e: 4
   * };
   * addNestedKeysToRoot(obj, 'b');
   * console.log(obj);
   * // Output: { a: 1, e: 4, c: 2, d: 3 }
  */
  static addNestedKeysToRoot(obj, key) {
    if (obj[key] && typeof obj[key] === 'object') {
      // Add nested keys to root
      Object.assign(obj, {
        ...obj[key]
      });
      // Delete original nested key
      delete obj[key];
    }
    return obj;
  }

  /**
   * Encodes a string to be used in a URL.
   * @param {String} input The string to encode.
   * @returns {String} The encoded string.
   */
  static encodeForUrl(input) {
    return encodeURIComponent(input).replace(/[!'.()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  }

  /**
   * Creates a JSON replacer function that handles Map, Set, and circular references.
   * This replacer can be used with JSON.stringify to safely serialize complex objects.
   *
   * @returns {Function} A replacer function for JSON.stringify that:
   * - Converts Map instances to plain objects
   * - Converts Set instances to arrays
   * - Replaces circular references with '[Circular]' marker
   *
   * @example
   * const obj = { name: 'test', map: new Map([['key', 'value']]) };
   * obj.self = obj; // circular reference
   * JSON.stringify(obj, Utils.getCircularReplacer());
   * // Output: {"name":"test","map":{"key":"value"},"self":"[Circular]"}
   */
  static getCircularReplacer() {
    const seen = new WeakSet();
    return (key, value) => {
      if (Utils.isMap(value)) {
        return Object.fromEntries(value);
      }
      if (Utils.isSet(value)) {
        return Array.from(value);
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    };
  }

  /**
   * Gets a nested property value from an object using dot notation.
   * @param {Object} obj The object to get the property from.
   * @param {String} path The property path in dot notation, e.g. 'databaseOptions.allowPublicExplain'.
   * @returns {any} The property value or undefined if not found.
   * @example
   * const obj = { database: { options: { enabled: true } } };
   * Utils.getNestedProperty(obj, 'database.options.enabled');
   * // Output: true
   */
  static getNestedProperty(obj, path) {
    if (!obj || !path) {
      return undefined;
    }
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }
      current = current[key];
    }
    return current;
  }

  /**
   * Parses a human-readable size string into a byte count.
   * @param {number | string} size - A number (floored to an integer), a numeric string
   *   (treated as bytes), or a string with a unit suffix: `b`, `kb`, `mb`, `gb`
   *   (case-insensitive). Examples: `'20mb'`, `'512kb'`, `'1.5gb'`, `1048576`.
   * @returns {number} The size in bytes, floored to the nearest integer.
   * @throws {Error} If the string does not match the expected format.
   */
  static parseSizeToBytes(size) {
    if (typeof size === 'number') {
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`Invalid size value: ${size}`);
      }
      return Math.floor(size);
    }
    const str = String(size).trim().toLowerCase();
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
    if (!match) {
      throw new Error(`Invalid size value: ${size}`);
    }
    const num = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'kb':
        return Math.floor(num * 1024);
      case 'mb':
        return Math.floor(num * 1024 * 1024);
      case 'gb':
        return Math.floor(num * 1024 * 1024 * 1024);
      default:
        return Math.floor(num);
    }
  }

  /**
   * Returns the file extension as the substring after the last dot in the
   * filename. A trailing dot or a filename without a dot yields an empty
   * string. Callers apply any further normalization (whitespace, MIME
   * parameters, etc.) for their use case — this is a pure parser, not a
   * policy.
   *
   * @param {string} filename
   * @returns {string} the extension, or `''` if none
   */
  static getFileExtension(filename) {
    if (!filename || !filename.includes('.')) {
      return '';
    }
    return filename.substring(filename.lastIndexOf('.') + 1);
  }
}
module.exports = Utils;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsImZzIiwicHJvbWlzZXMiLCJ0eXBlcyIsIlV0aWxzIiwiZ2V0TG9jYWxpemVkUGF0aCIsImRlZmF1bHRQYXRoIiwibG9jYWxlIiwiZmlsZSIsImJhc2VuYW1lIiwiYmFzZVBhdGgiLCJkaXJuYW1lIiwibG9jYWxlUGF0aCIsImpvaW4iLCJsb2NhbGVGaWxlRXhpc3RzIiwiZmlsZUV4aXN0cyIsInN1YmRpciIsImxhbmd1YWdlIiwic3BsaXQiLCJsYW5ndWFnZVBhdGgiLCJsYW5ndWFnZUZpbGVFeGlzdHMiLCJhY2Nlc3MiLCJpc1BhdGgiLCJzIiwidGVzdCIsImZsYXR0ZW5PYmplY3QiLCJvYmoiLCJwYXJlbnRLZXkiLCJkZWxpbWl0ZXIiLCJyZXN1bHQiLCJrZXkiLCJPYmplY3QiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJuZXdLZXkiLCJpc0RhdGUiLCJ2YWx1ZSIsImlzUmVnRXhwIiwiaXNNYXAiLCJpc1NldCIsImlzTmF0aXZlRXJyb3IiLCJpc1Byb21pc2UiLCJ0aGVuIiwiZ2V0UHJvdG90eXBlT2YiLCJpc09iamVjdCIsImdldE9iamVjdEtleVBlcm11dGF0aW9ucyIsIm9iamVjdCIsImluZGV4IiwiY3VycmVudCIsInJlc3VsdHMiLCJrZXlzIiwidmFsdWVzIiwibmV4dEluZGV4IiwibGVuZ3RoIiwiYXNzaWduIiwicHVzaCIsInZhbGlkYXRlUGFyYW1zIiwicGFyYW1zIiwidHlwZSIsImlzT3B0aW9uYWwiLCJvIiwicGFyYW0iLCJ2IiwidCIsInJlbGF0aXZlVGltZVRvRGF0ZSIsInRleHQiLCJub3ciLCJEYXRlIiwidG9Mb3dlckNhc2UiLCJwYXJ0cyIsImZpbHRlciIsInBhcnQiLCJmdXR1cmUiLCJwYXN0Iiwic3RhdHVzIiwiaW5mbyIsInNsaWNlIiwicGFpcnMiLCJzaGlmdCIsInNlY29uZHMiLCJudW0iLCJpbnRlcnZhbCIsInZhbCIsIk51bWJlciIsImlzSW50ZWdlciIsIm1pbGxpc2Vjb25kcyIsInZhbHVlT2YiLCJvYmplY3RDb250YWluc0tleVZhbHVlIiwiaXNNYXRjaCIsImEiLCJiIiwiUmVnRXhwIiwiaXNLZXlNYXRjaCIsImsiLCJpc1ZhbHVlTWF0Y2giLCJzdGFjayIsInNlZW4iLCJXZWFrU2V0IiwicG9wIiwiaGFzIiwiYWRkIiwiZW50cmllcyIsInVuZGVmaW5lZCIsImluY2x1ZGVzIiwidG9TdHJpbmciLCJjaGVja1Byb2hpYml0ZWRLZXl3b3JkcyIsImNvbmZpZyIsImRhdGEiLCJyZXF1ZXN0S2V5d29yZERlbnlsaXN0Iiwia2V5d29yZCIsIm1hdGNoIiwiSlNPTiIsInN0cmluZ2lmeSIsImFkZE5lc3RlZEtleXNUb1Jvb3QiLCJlbmNvZGVGb3JVcmwiLCJpbnB1dCIsImVuY29kZVVSSUNvbXBvbmVudCIsInJlcGxhY2UiLCJjaGFyIiwiY2hhckNvZGVBdCIsInRvVXBwZXJDYXNlIiwiZ2V0Q2lyY3VsYXJSZXBsYWNlciIsImZyb21FbnRyaWVzIiwiQXJyYXkiLCJmcm9tIiwiZ2V0TmVzdGVkUHJvcGVydHkiLCJwYXJzZVNpemVUb0J5dGVzIiwic2l6ZSIsImlzRmluaXRlIiwiRXJyb3IiLCJNYXRoIiwiZmxvb3IiLCJzdHIiLCJTdHJpbmciLCJ0cmltIiwicGFyc2VGbG9hdCIsInVuaXQiLCJnZXRGaWxlRXh0ZW5zaW9uIiwiZmlsZW5hbWUiLCJzdWJzdHJpbmciLCJsYXN0SW5kZXhPZiIsIm1vZHVsZSIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi9zcmMvVXRpbHMuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiB1dGlscy5qc1xuICogQGZpbGUgR2VuZXJhbCBwdXJwb3NlIHV0aWxpdGllc1xuICogQGRlc2NyaXB0aW9uIEdlbmVyYWwgcHVycG9zZSB1dGlsaXRpZXMuXG4gKi9cblxuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IGZzID0gcmVxdWlyZSgnZnMnKS5wcm9taXNlcztcbmNvbnN0IHsgdHlwZXMgfSA9IHJlcXVpcmUoJ3V0aWwnKTtcblxuLyoqXG4gKiBUaGUgZ2VuZXJhbCBwdXJwb3NlIHV0aWxpdGllcy5cbiAqL1xuY2xhc3MgVXRpbHMge1xuICAvKipcbiAgICogQGZ1bmN0aW9uIGdldExvY2FsaXplZFBhdGhcbiAgICogQGRlc2NyaXB0aW9uIFJldHVybnMgYSBsb2NhbGl6ZWQgZmlsZSBwYXRoIGFjY29yaW5nIHRvIHRoZSBsb2NhbGUuXG4gICAqXG4gICAqIExvY2FsaXplZCBmaWxlcyBhcmUgc2VhcmNoZWQgaW4gc3ViZm9sZGVycyBvZiBhIGdpdmVuIHBhdGgsIGUuZy5cbiAgICpcbiAgICogcm9vdC9cbiAgICog4pSc4pSA4pSAIGJhc2UvICAgICAgICAgICAgICAgICAgICAvLyBiYXNlIHBhdGggdG8gZmlsZXNcbiAgICog4pSCICAg4pSc4pSA4pSAIGV4YW1wbGUuaHRtbCAgICAgICAgIC8vIGRlZmF1bHQgZmlsZVxuICAgKiDilIIgICDilJTilIDilIAgZGUvICAgICAgICAgICAgICAgICAgLy8gZGUgbGFuZ3VhZ2UgZm9sZGVyXG4gICAqIOKUgiAgIOKUgiAgIOKUlOKUgOKUgCBleGFtcGxlLmh0bWwgICAgIC8vIGRlIGxvY2FsaXplZCBmaWxlXG4gICAqIOKUgiAgIOKUlOKUgOKUgCBkZS1BVC8gICAgICAgICAgICAgICAvLyBkZS1BVCBsb2NhbGUgZm9sZGVyXG4gICAqIOKUgiAgIOKUgiAgIOKUlOKUgOKUgCBleGFtcGxlLmh0bWwgICAgIC8vIGRlLUFUIGxvY2FsaXplZCBmaWxlXG4gICAqXG4gICAqIEZpbGVzIGFyZSBtYXRjaGVkIHdpdGggdGhlIGxvY2FsZSBpbiB0aGUgZm9sbG93aW5nIG9yZGVyOlxuICAgKiAxLiBMb2NhbGUgbWF0Y2gsIGUuZy4gbG9jYWxlIGBkZS1BVGAgbWF0Y2hlcyBmaWxlIGluIGZvbGRlciBgZGUtQVRgLlxuICAgKiAyLiBMYW5ndWFnZSBtYXRjaCwgZS5nLiBsb2NhbGUgYGRlLUFUYCBtYXRjaGVzIGZpbGUgaW4gZm9sZGVyIGBkZWAuXG4gICAqIDMuIERlZmF1bHQ7IGZpbGUgaW4gYmFzZSBmb2xkZXIgaXMgcmV0dXJuZWQuXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBkZWZhdWx0UGF0aCBUaGUgYWJzb2x1dGUgZmlsZSBwYXRoLCB3aGljaCBpcyBhbHNvXG4gICAqIHRoZSBkZWZhdWx0IHBhdGggcmV0dXJuZWQgaWYgbG9jYWxpemF0aW9uIGlzIG5vdCBhdmFpbGFibGUuXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBsb2NhbGUgVGhlIGxvY2FsZS5cbiAgICogQHJldHVybnMge1Byb21pc2U8T2JqZWN0Pn0gVGhlIG9iamVjdCBjb250YWluczpcbiAgICogLSBgcGF0aGA6IFRoZSBwYXRoIHRvIHRoZSBsb2NhbGl6ZWQgZmlsZSwgb3IgdGhlIG9yaWdpbmFsIHBhdGggaWZcbiAgICogICBsb2NhbGl6YXRpb24gaXMgbm90IGF2YWlsYWJsZS5cbiAgICogLSBgc3ViZGlyYDogVGhlIHN1YmRpcmVjdG9yeSBvZiB0aGUgbG9jYWxpemVkIGZpbGUsIG9yIHVuZGVmaW5lZCBpZlxuICAgKiAgIHRoZXJlIGlzIG5vIG1hdGNoaW5nIGxvY2FsaXplZCBmaWxlLlxuICAgKi9cbiAgc3RhdGljIGFzeW5jIGdldExvY2FsaXplZFBhdGgoZGVmYXVsdFBhdGgsIGxvY2FsZSkge1xuICAgIC8vIEdldCBmaWxlIG5hbWUgYW5kIHBhdGhzXG4gICAgY29uc3QgZmlsZSA9IHBhdGguYmFzZW5hbWUoZGVmYXVsdFBhdGgpO1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcGF0aC5kaXJuYW1lKGRlZmF1bHRQYXRoKTtcblxuICAgIC8vIElmIGxvY2FsZSBpcyBub3Qgc2V0IHJldHVybiBkZWZhdWx0IGZpbGVcbiAgICBpZiAoIWxvY2FsZSkge1xuICAgICAgcmV0dXJuIHsgcGF0aDogZGVmYXVsdFBhdGggfTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmaWxlIGZvciBsb2NhbGUgZXhpc3RzXG4gICAgY29uc3QgbG9jYWxlUGF0aCA9IHBhdGguam9pbihiYXNlUGF0aCwgbG9jYWxlLCBmaWxlKTtcbiAgICBjb25zdCBsb2NhbGVGaWxlRXhpc3RzID0gYXdhaXQgVXRpbHMuZmlsZUV4aXN0cyhsb2NhbGVQYXRoKTtcblxuICAgIC8vIElmIGZpbGUgZm9yIGxvY2FsZSBleGlzdHMgcmV0dXJuIGZpbGVcbiAgICBpZiAobG9jYWxlRmlsZUV4aXN0cykge1xuICAgICAgcmV0dXJuIHsgcGF0aDogbG9jYWxlUGF0aCwgc3ViZGlyOiBsb2NhbGUgfTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmaWxlIGZvciBsYW5ndWFnZSBleGlzdHNcbiAgICBjb25zdCBsYW5ndWFnZSA9IGxvY2FsZS5zcGxpdCgnLScpWzBdO1xuICAgIGNvbnN0IGxhbmd1YWdlUGF0aCA9IHBhdGguam9pbihiYXNlUGF0aCwgbGFuZ3VhZ2UsIGZpbGUpO1xuICAgIGNvbnN0IGxhbmd1YWdlRmlsZUV4aXN0cyA9IGF3YWl0IFV0aWxzLmZpbGVFeGlzdHMobGFuZ3VhZ2VQYXRoKTtcblxuICAgIC8vIElmIGZpbGUgZm9yIGxhbmd1YWdlIGV4aXN0cyByZXR1cm4gZmlsZVxuICAgIGlmIChsYW5ndWFnZUZpbGVFeGlzdHMpIHtcbiAgICAgIHJldHVybiB7IHBhdGg6IGxhbmd1YWdlUGF0aCwgc3ViZGlyOiBsYW5ndWFnZSB9O1xuICAgIH1cblxuICAgIC8vIFJldHVybiBkZWZhdWx0IGZpbGVcbiAgICByZXR1cm4geyBwYXRoOiBkZWZhdWx0UGF0aCB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEBmdW5jdGlvbiBmaWxlRXhpc3RzXG4gICAqIEBkZXNjcmlwdGlvbiBDaGVja3Mgd2hldGhlciBhIGZpbGUgZXhpc3RzLlxuICAgKiBAcGFyYW0ge1N0cmluZ30gcGF0aCBUaGUgZmlsZSBwYXRoLlxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxCb29sZWFuPn0gSXMgdHJ1ZSBpZiB0aGUgZmlsZSBjYW4gYmUgYWNjZXNzZWQsIGZhbHNlIG90aGVyd2lzZS5cbiAgICovXG4gIHN0YXRpYyBhc3luYyBmaWxlRXhpc3RzKHBhdGgpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZnMuYWNjZXNzKHBhdGgpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBmdW5jdGlvbiBpc1BhdGhcbiAgICogQGRlc2NyaXB0aW9uIEV2YWx1YXRlcyB3aGV0aGVyIGEgc3RyaW5nIGlzIGEgZmlsZSBwYXRoIChhcyBvcHBvc2VkIHRvIGEgVVJMIGZvciBleGFtcGxlKS5cbiAgICogQHBhcmFtIHtTdHJpbmd9IHMgVGhlIHN0cmluZyB0byBldmFsdWF0ZS5cbiAgICogQHJldHVybnMge0Jvb2xlYW59IFJldHVybnMgdHJ1ZSBpZiB0aGUgZXZhbHVhdGVkIHN0cmluZyBpcyBhIHBhdGguXG4gICAqL1xuICBzdGF0aWMgaXNQYXRoKHMpIHtcbiAgICByZXR1cm4gLyheXFwvKXwoXlxcLlxcLyl8KF5cXC5cXC5cXC8pLy50ZXN0KHMpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZsYXR0ZW5zIGFuIG9iamVjdCBhbmQgY3JhdGVzIG5ldyBrZXlzIHdpdGggY3VzdG9tIGRlbGltaXRlcnMuXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvYmogVGhlIG9iamVjdCB0byBmbGF0dGVuLlxuICAgKiBAcGFyYW0ge1N0cmluZ30gW2RlbGltaXRlcj0nLiddIFRoZSBkZWxpbWl0ZXIgb2YgdGhlIG5ld2x5IGdlbmVyYXRlZCBrZXlzLlxuICAgKiBAcGFyYW0ge09iamVjdH0gcmVzdWx0XG4gICAqIEByZXR1cm5zIHtPYmplY3R9IFRoZSBmbGF0dGVuZWQgb2JqZWN0LlxuICAgKiovXG4gIHN0YXRpYyBmbGF0dGVuT2JqZWN0KG9iaiwgcGFyZW50S2V5LCBkZWxpbWl0ZXIgPSAnLicsIHJlc3VsdCA9IHt9KSB7XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb2JqKSB7XG4gICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwga2V5KSkge1xuICAgICAgICBjb25zdCBuZXdLZXkgPSBwYXJlbnRLZXkgPyBwYXJlbnRLZXkgKyBkZWxpbWl0ZXIgKyBrZXkgOiBrZXk7XG5cbiAgICAgICAgaWYgKHR5cGVvZiBvYmpba2V5XSA9PT0gJ29iamVjdCcgJiYgb2JqW2tleV0gIT09IG51bGwpIHtcbiAgICAgICAgICB0aGlzLmZsYXR0ZW5PYmplY3Qob2JqW2tleV0sIG5ld0tleSwgZGVsaW1pdGVyLCByZXN1bHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdFtuZXdLZXldID0gb2JqW2tleV07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWFsbS1zYWZlIGNoZWNrIGZvciBEYXRlLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIERhdGUuXG4gICAqL1xuICBzdGF0aWMgaXNEYXRlKHZhbHVlKSB7XG4gICAgcmV0dXJuIHR5cGVzLmlzRGF0ZSh2YWx1ZSk7XG4gIH1cblxuICAvKipcbiAgICogUmVhbG0tc2FmZSBjaGVjayBmb3IgUmVnRXhwLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIFJlZ0V4cC5cbiAgICovXG4gIHN0YXRpYyBpc1JlZ0V4cCh2YWx1ZSkge1xuICAgIHJldHVybiB0eXBlcy5pc1JlZ0V4cCh2YWx1ZSk7XG4gIH1cblxuICAvKipcbiAgICogUmVhbG0tc2FmZSBjaGVjayBmb3IgTWFwLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIE1hcC5cbiAgICovXG4gIHN0YXRpYyBpc01hcCh2YWx1ZSkge1xuICAgIHJldHVybiB0eXBlcy5pc01hcCh2YWx1ZSk7XG4gIH1cblxuICAvKipcbiAgICogUmVhbG0tc2FmZSBjaGVjayBmb3IgU2V0LlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIFNldC5cbiAgICovXG4gIHN0YXRpYyBpc1NldCh2YWx1ZSkge1xuICAgIHJldHVybiB0eXBlcy5pc1NldCh2YWx1ZSk7XG4gIH1cblxuICAvKipcbiAgICogUmVhbG0tc2FmZSBjaGVjayBmb3IgbmF0aXZlIEVycm9yLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIG5hdGl2ZSBFcnJvci5cbiAgICovXG4gIHN0YXRpYyBpc05hdGl2ZUVycm9yKHZhbHVlKSB7XG4gICAgcmV0dXJuIHR5cGVzLmlzTmF0aXZlRXJyb3IodmFsdWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlYWxtLXNhZmUgY2hlY2sgZm9yIFByb21pc2UgKGR1Y2stdHlwZWQgYXMgdGhlbmFibGUpLlxuICAgKiBHdWFyZHMgYWdhaW5zdCBPYmplY3QucHJvdG90eXBlIHBvbGx1dGlvbiBieSBlbnN1cmluZyBgdGhlbmAgaXMgbm90XG4gICAqIGluaGVyaXRlZCBzb2xlbHkgZnJvbSBPYmplY3QucHJvdG90eXBlLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIFByb21pc2Ugb3IgdGhlbmFibGUuXG4gICAqL1xuICBzdGF0aWMgaXNQcm9taXNlKHZhbHVlKSB7XG4gICAgaWYgKHZhbHVlID09IG51bGwgfHwgdHlwZW9mIHZhbHVlLnRoZW4gIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIE9iamVjdC5nZXRQcm90b3R5cGVPZih2YWx1ZSkgIT09IE9iamVjdC5wcm90b3R5cGUgfHwgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHZhbHVlLCAndGhlbicpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlYWxtLXNhZmUgY2hlY2sgZm9yIG9iamVjdCB0eXBlLiBVc2VzIGB0eXBlb2ZgIGluc3RlYWQgb2YgYGluc3RhbmNlb2YgT2JqZWN0YFxuICAgKiB3aGljaCBmYWlscyBhY3Jvc3MgcmVhbG1zLiBSZXR1cm5zIHRydWUgZm9yIGFueSBub24tbnVsbCB2YWx1ZSB3aGVyZVxuICAgKiBgdHlwZW9mYCBpcyBgJ29iamVjdCdgLCBpbmNsdWRpbmcgcGxhaW4gb2JqZWN0cywgYXJyYXlzLCBkYXRlcywgbWFwcywgc2V0cyxcbiAgICogcmVnZXgsIGFuZCBib3hlZCBwcmltaXRpdmVzIChlLmcuIGBuZXcgU3RyaW5nKClgKS4gUmV0dXJucyBmYWxzZSBmb3IgYG51bGxgLFxuICAgKiBgdW5kZWZpbmVkYCwgdW5ib3hlZCBwcmltaXRpdmVzLCBhbmQgZnVuY3Rpb25zLlxuICAgKiBAcGFyYW0ge2FueX0gdmFsdWUgVGhlIHZhbHVlIHRvIGNoZWNrLlxuICAgKiBAcmV0dXJucyB7Qm9vbGVhbn0gUmV0dXJucyB0cnVlIGlmIHRoZSB2YWx1ZSBpcyBhIG5vbi1udWxsIG9iamVjdCB0eXBlLlxuICAgKi9cbiAgc3RhdGljIGlzT2JqZWN0KHZhbHVlKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGw7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlcyBhbiBvYmplY3Qgd2l0aCBhbGwgcGVybXV0YXRpb25zIG9mIHRoZSBvcmlnaW5hbCBrZXlzLlxuICAgKiBGb3IgZXhhbXBsZSwgdGhpcyBkZWZpbml0aW9uOlxuICAgKiBgYGBcbiAgICoge1xuICAgKiAgIGE6IFt0cnVlLCBmYWxzZV0sXG4gICAqICAgYjogWzEsIDJdLFxuICAgKiAgIGM6IFsneCddXG4gICAqIH1cbiAgICogYGBgXG4gICAqIHBlcm11dGF0ZXMgdG86XG4gICAqIGBgYFxuICAgKiBbXG4gICAqICAgeyBhOiB0cnVlLCBiOiAxLCBjOiAneCcgfSxcbiAgICogICB7IGE6IHRydWUsIGI6IDIsIGM6ICd4JyB9LFxuICAgKiAgIHsgYTogZmFsc2UsIGI6IDEsIGM6ICd4JyB9LFxuICAgKiAgIHsgYTogZmFsc2UsIGI6IDIsIGM6ICd4JyB9XG4gICAqIF1cbiAgICogYGBgXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvYmplY3QgVGhlIG9iamVjdCB0byBwZXJtdXRhdGUuXG4gICAqIEBwYXJhbSB7SW50ZWdlcn0gW2luZGV4PTBdIFRoZSBjdXJyZW50IGtleSBpbmRleC5cbiAgICogQHBhcmFtIHtPYmplY3R9IFtjdXJyZW50PXt9XSBUaGUgY3VycmVudCByZXN1bHQgZW50cnkgYmVpbmcgY29tcG9zZWQuXG4gICAqIEBwYXJhbSB7QXJyYXl9IFtyZXN1bHRzPVtdXSBUaGUgcmVzdWx0aW5nIGFycmF5IG9mIHBlcm11dGF0aW9ucy5cbiAgICovXG4gIHN0YXRpYyBnZXRPYmplY3RLZXlQZXJtdXRhdGlvbnMob2JqZWN0LCBpbmRleCA9IDAsIGN1cnJlbnQgPSB7fSwgcmVzdWx0cyA9IFtdKSB7XG4gICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iamVjdCk7XG4gICAgY29uc3Qga2V5ID0ga2V5c1tpbmRleF07XG4gICAgY29uc3QgdmFsdWVzID0gb2JqZWN0W2tleV07XG5cbiAgICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgICAgY3VycmVudFtrZXldID0gdmFsdWU7XG4gICAgICBjb25zdCBuZXh0SW5kZXggPSBpbmRleCArIDE7XG5cbiAgICAgIGlmIChuZXh0SW5kZXggPCBrZXlzLmxlbmd0aCkge1xuICAgICAgICBVdGlscy5nZXRPYmplY3RLZXlQZXJtdXRhdGlvbnMob2JqZWN0LCBuZXh0SW5kZXgsIGN1cnJlbnQsIHJlc3VsdHMpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gT2JqZWN0LmFzc2lnbih7fSwgY3VycmVudCk7XG4gICAgICAgIHJlc3VsdHMucHVzaChyZXN1bHQpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZXMgcGFyYW1ldGVycyBhbmQgdGhyb3dzIGlmIGEgcGFyYW1ldGVyIGlzIGludmFsaWQuXG4gICAqIEV4YW1wbGUgcGFyYW1ldGVyIHR5cGVzIHN5bnRheDpcbiAgICogYGBgXG4gICAqIHtcbiAgICogICBwYXJhbWV0ZXJOYW1lOiB7XG4gICAqICAgICAgdDogJ2Jvb2xlYW4nLFxuICAgKiAgICAgIHY6IGlzQm9vbGVhbixcbiAgICogICAgICBvOiB0cnVlXG4gICAqICAgfSxcbiAgICogICAuLi5cbiAgICogfVxuICAgKiBgYGBcbiAgICogQHBhcmFtIHtPYmplY3R9IHBhcmFtcyBUaGUgcGFyYW1ldGVycyB0byB2YWxpZGF0ZS5cbiAgICogQHBhcmFtIHtBcnJheTxPYmplY3Q+fSB0eXBlcyBUaGUgcGFyYW1ldGVyIHR5cGVzIHVzZWQgZm9yIHZhbGlkYXRpb24uXG4gICAqIEBwYXJhbSB7T2JqZWN0fSB0eXBlcy50IFRoZSBwYXJhbWV0ZXIgdHlwZTsgdXNlZCBmb3IgZXJyb3IgbWVzc2FnZSwgbm90IGZvciB2YWxpZGF0aW9uLlxuICAgKiBAcGFyYW0ge09iamVjdH0gdHlwZXMudiBUaGUgZnVuY3Rpb24gdG8gdmFsaWRhdGUgdGhlIHBhcmFtZXRlciB2YWx1ZS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBbdHlwZXMubz1mYWxzZV0gSXMgdHJ1ZSBpZiB0aGUgcGFyYW1ldGVyIGlzIG9wdGlvbmFsLlxuICAgKi9cbiAgc3RhdGljIHZhbGlkYXRlUGFyYW1zKHBhcmFtcywgdHlwZXMpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXJhbXMpKSB7XG4gICAgICBjb25zdCB0eXBlID0gdHlwZXNba2V5XTtcbiAgICAgIGNvbnN0IGlzT3B0aW9uYWwgPSAhIXR5cGUubztcbiAgICAgIGNvbnN0IHBhcmFtID0gcGFyYW1zW2tleV07XG4gICAgICBpZiAoIShpc09wdGlvbmFsICYmIHBhcmFtID09IG51bGwpICYmICF0eXBlLnYocGFyYW0pKSB7XG4gICAgICAgIHRocm93IGBJbnZhbGlkIHBhcmFtZXRlciAke2tleX0gbXVzdCBiZSBvZiB0eXBlICR7dHlwZS50fSBidXQgaXMgJHt0eXBlb2YgcGFyYW19YDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ29tcHV0ZXMgdGhlIHJlbGF0aXZlIGRhdGUgYmFzZWQgb24gYSBzdHJpbmcuXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB0ZXh0IFRoZSBzdHJpbmcgdG8gaW50ZXJwcmV0IHRoZSBkYXRlIGZyb20uXG4gICAqIEBwYXJhbSB7RGF0ZX0gbm93IFRoZSBkYXRlIHRoZSBzdHJpbmcgaXMgY29tcGFyaW5nIGFnYWluc3QuXG4gICAqIEByZXR1cm5zIHtPYmplY3R9IFRoZSByZWxhdGl2ZSBkYXRlIG9iamVjdC5cbiAgICoqL1xuICBzdGF0aWMgcmVsYXRpdmVUaW1lVG9EYXRlKHRleHQsIG5vdyA9IG5ldyBEYXRlKCkpIHtcbiAgICB0ZXh0ID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuICAgIGxldCBwYXJ0cyA9IHRleHQuc3BsaXQoJyAnKTtcblxuICAgIC8vIEZpbHRlciBvdXQgd2hpdGVzcGFjZVxuICAgIHBhcnRzID0gcGFydHMuZmlsdGVyKHBhcnQgPT4gcGFydCAhPT0gJycpO1xuXG4gICAgY29uc3QgZnV0dXJlID0gcGFydHNbMF0gPT09ICdpbic7XG4gICAgY29uc3QgcGFzdCA9IHBhcnRzW3BhcnRzLmxlbmd0aCAtIDFdID09PSAnYWdvJztcblxuICAgIGlmICghZnV0dXJlICYmICFwYXN0ICYmIHRleHQgIT09ICdub3cnKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgIGluZm86IFwiVGltZSBzaG91bGQgZWl0aGVyIHN0YXJ0IHdpdGggJ2luJyBvciBlbmQgd2l0aCAnYWdvJ1wiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoZnV0dXJlICYmIHBhc3QpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1czogJ2Vycm9yJyxcbiAgICAgICAgaW5mbzogXCJUaW1lIGNhbm5vdCBoYXZlIGJvdGggJ2luJyBhbmQgJ2FnbydcIixcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gc3RyaXAgdGhlICdhZ28nIG9yICdpbidcbiAgICBpZiAoZnV0dXJlKSB7XG4gICAgICBwYXJ0cyA9IHBhcnRzLnNsaWNlKDEpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBwYXN0XG4gICAgICBwYXJ0cyA9IHBhcnRzLnNsaWNlKDAsIHBhcnRzLmxlbmd0aCAtIDEpO1xuICAgIH1cblxuICAgIGlmIChwYXJ0cy5sZW5ndGggJSAyICE9PSAwICYmIHRleHQgIT09ICdub3cnKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgIGluZm86ICdJbnZhbGlkIHRpbWUgc3RyaW5nLiBEYW5nbGluZyB1bml0IG9yIG51bWJlci4nLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBwYWlycyA9IFtdO1xuICAgIHdoaWxlIChwYXJ0cy5sZW5ndGgpIHtcbiAgICAgIHBhaXJzLnB1c2goW3BhcnRzLnNoaWZ0KCksIHBhcnRzLnNoaWZ0KCldKTtcbiAgICB9XG5cbiAgICBsZXQgc2Vjb25kcyA9IDA7XG4gICAgZm9yIChjb25zdCBbbnVtLCBpbnRlcnZhbF0gb2YgcGFpcnMpIHtcbiAgICAgIGNvbnN0IHZhbCA9IE51bWJlcihudW0pO1xuICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXM6ICdlcnJvcicsXG4gICAgICAgICAgaW5mbzogYCcke251bX0nIGlzIG5vdCBhbiBpbnRlZ2VyLmAsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIHN3aXRjaCAoaW50ZXJ2YWwpIHtcbiAgICAgICAgY2FzZSAneXInOlxuICAgICAgICBjYXNlICd5cnMnOlxuICAgICAgICBjYXNlICd5ZWFyJzpcbiAgICAgICAgY2FzZSAneWVhcnMnOlxuICAgICAgICAgIHNlY29uZHMgKz0gdmFsICogMzE1MzYwMDA7IC8vIDM2NSAqIDI0ICogNjAgKiA2MFxuICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ3drJzpcbiAgICAgICAgY2FzZSAnd2tzJzpcbiAgICAgICAgY2FzZSAnd2Vlayc6XG4gICAgICAgIGNhc2UgJ3dlZWtzJzpcbiAgICAgICAgICBzZWNvbmRzICs9IHZhbCAqIDYwNDgwMDsgLy8gNyAqIDI0ICogNjAgKiA2MFxuICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2QnOlxuICAgICAgICBjYXNlICdkYXknOlxuICAgICAgICBjYXNlICdkYXlzJzpcbiAgICAgICAgICBzZWNvbmRzICs9IHZhbCAqIDg2NDAwOyAvLyAyNCAqIDYwICogNjBcbiAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdocic6XG4gICAgICAgIGNhc2UgJ2hycyc6XG4gICAgICAgIGNhc2UgJ2hvdXInOlxuICAgICAgICBjYXNlICdob3Vycyc6XG4gICAgICAgICAgc2Vjb25kcyArPSB2YWwgKiAzNjAwOyAvLyA2MCAqIDYwXG4gICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnbWluJzpcbiAgICAgICAgY2FzZSAnbWlucyc6XG4gICAgICAgIGNhc2UgJ21pbnV0ZSc6XG4gICAgICAgIGNhc2UgJ21pbnV0ZXMnOlxuICAgICAgICAgIHNlY29uZHMgKz0gdmFsICogNjA7XG4gICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnc2VjJzpcbiAgICAgICAgY2FzZSAnc2Vjcyc6XG4gICAgICAgIGNhc2UgJ3NlY29uZCc6XG4gICAgICAgIGNhc2UgJ3NlY29uZHMnOlxuICAgICAgICAgIHNlY29uZHMgKz0gdmFsO1xuICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YXR1czogJ2Vycm9yJyxcbiAgICAgICAgICAgIGluZm86IGBJbnZhbGlkIGludGVydmFsOiAnJHtpbnRlcnZhbH0nYCxcbiAgICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IG1pbGxpc2Vjb25kcyA9IHNlY29uZHMgKiAxMDAwO1xuICAgIGlmIChmdXR1cmUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1czogJ3N1Y2Nlc3MnLFxuICAgICAgICBpbmZvOiAnZnV0dXJlJyxcbiAgICAgICAgcmVzdWx0OiBuZXcgRGF0ZShub3cudmFsdWVPZigpICsgbWlsbGlzZWNvbmRzKSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChwYXN0KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6ICdzdWNjZXNzJyxcbiAgICAgICAgaW5mbzogJ3Bhc3QnLFxuICAgICAgICByZXN1bHQ6IG5ldyBEYXRlKG5vdy52YWx1ZU9mKCkgLSBtaWxsaXNlY29uZHMpLFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzOiAnc3VjY2VzcycsXG4gICAgICAgIGluZm86ICdwcmVzZW50JyxcbiAgICAgICAgcmVzdWx0OiBuZXcgRGF0ZShub3cudmFsdWVPZigpKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIERlZXAtc2NhbnMgYW4gb2JqZWN0IGZvciBhIG1hdGNoaW5nIGtleS92YWx1ZSBkZWZpbml0aW9uLlxuICAgKiBAcGFyYW0ge09iamVjdH0gb2JqIFRoZSBvYmplY3QgdG8gc2Nhbi5cbiAgICogQHBhcmFtIHtTdHJpbmcgfCB1bmRlZmluZWR9IGtleSBUaGUga2V5IHRvIG1hdGNoLCBvciB1bmRlZmluZWQgaWYgb25seSB0aGUgdmFsdWUgc2hvdWxkIGJlIG1hdGNoZWQuXG4gICAqIEBwYXJhbSB7YW55IHwgdW5kZWZpbmVkfSB2YWx1ZSBUaGUgdmFsdWUgdG8gbWF0Y2gsIG9yIHVuZGVmaW5lZCBpZiBvbmx5IHRoZSBrZXkgc2hvdWxkIGJlIG1hdGNoZWQuXG4gICAqIEByZXR1cm5zIHtCb29sZWFufSBUcnVlIGlmIGEgbWF0Y2ggd2FzIGZvdW5kLCBmYWxzZSBvdGhlcndpc2UuXG4gICAqL1xuICBzdGF0aWMgb2JqZWN0Q29udGFpbnNLZXlWYWx1ZShvYmosIGtleSwgdmFsdWUpIHtcbiAgICBjb25zdCBpc01hdGNoID0gKGEsIGIpID0+ICh0eXBlb2YgYSA9PT0gJ3N0cmluZycgJiYgbmV3IFJlZ0V4cChiKS50ZXN0KGEpKSB8fCBhID09PSBiO1xuICAgIGNvbnN0IGlzS2V5TWF0Y2ggPSBrID0+IGlzTWF0Y2goaywga2V5KTtcbiAgICBjb25zdCBpc1ZhbHVlTWF0Y2ggPSB2ID0+IGlzTWF0Y2godiwgdmFsdWUpO1xuICAgIGNvbnN0IHN0YWNrID0gW29ial07XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBXZWFrU2V0KCk7XG4gICAgd2hpbGUgKHN0YWNrLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBzdGFjay5wb3AoKTtcbiAgICAgIGlmIChzZWVuLmhhcyhjdXJyZW50KSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHNlZW4uYWRkKGN1cnJlbnQpO1xuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoY3VycmVudCkpIHtcbiAgICAgICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIHZhbHVlID09PSB1bmRlZmluZWQgJiYgaXNLZXlNYXRjaChrKSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKGtleSA9PT0gdW5kZWZpbmVkICYmIHZhbHVlICE9PSB1bmRlZmluZWQgJiYgaXNWYWx1ZU1hdGNoKHYpKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gZWxzZSBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgdmFsdWUgIT09IHVuZGVmaW5lZCAmJiBpc0tleU1hdGNoKGspICYmIGlzVmFsdWVNYXRjaCh2KSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChbJ1tvYmplY3QgT2JqZWN0XScsICdbb2JqZWN0IEFycmF5XSddLmluY2x1ZGVzKE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2KSkpIHtcbiAgICAgICAgICBzdGFjay5wdXNoKHYpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHN0YXRpYyBjaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyhjb25maWcsIGRhdGEpIHtcbiAgICBpZiAoY29uZmlnPy5yZXF1ZXN0S2V5d29yZERlbnlsaXN0KSB7XG4gICAgICAvLyBTY2FuIHJlcXVlc3QgZGF0YSBmb3IgZGVuaWVkIGtleXdvcmRzXG4gICAgICBmb3IgKGNvbnN0IGtleXdvcmQgb2YgY29uZmlnLnJlcXVlc3RLZXl3b3JkRGVueWxpc3QpIHtcbiAgICAgICAgY29uc3QgbWF0Y2ggPSBVdGlscy5vYmplY3RDb250YWluc0tleVZhbHVlKGRhdGEsIGtleXdvcmQua2V5LCBrZXl3b3JkLnZhbHVlKTtcbiAgICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgICAgdGhyb3cgYFByb2hpYml0ZWQga2V5d29yZCBpbiByZXF1ZXN0IGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoa2V5d29yZCl9LmA7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogTW92ZXMgdGhlIG5lc3RlZCBrZXlzIG9mIGEgc3BlY2lmaWVkIGtleSBpbiBhbiBvYmplY3QgdG8gdGhlIHJvb3Qgb2YgdGhlIG9iamVjdC5cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IG9iaiBUaGUgb2JqZWN0IHRvIG1vZGlmeS5cbiAgICogQHBhcmFtIHtTdHJpbmd9IGtleSBUaGUga2V5IHdob3NlIG5lc3RlZCBrZXlzIHdpbGwgYmUgbW92ZWQgdG8gcm9vdC5cbiAgICogQHJldHVybnMge09iamVjdH0gVGhlIG1vZGlmaWVkIG9iamVjdCwgb3IgdGhlIG9yaWdpbmFsIG9iamVjdCBpZiBubyBtb2RpZmljYXRpb24gaGFwcGVuZWQuXG4gICAqIEBleGFtcGxlXG4gICAqIGNvbnN0IG9iaiA9IHtcbiAgICogICBhOiAxLFxuICAgKiAgIGI6IHtcbiAgICogICAgIGM6IDIsXG4gICAqICAgICBkOiAzXG4gICAqICAgfSxcbiAgICogICBlOiA0XG4gICAqIH07XG4gICAqIGFkZE5lc3RlZEtleXNUb1Jvb3Qob2JqLCAnYicpO1xuICAgKiBjb25zb2xlLmxvZyhvYmopO1xuICAgKiAvLyBPdXRwdXQ6IHsgYTogMSwgZTogNCwgYzogMiwgZDogMyB9XG4gICovXG4gIHN0YXRpYyBhZGROZXN0ZWRLZXlzVG9Sb290KG9iaiwga2V5KSB7XG4gICAgaWYgKG9ialtrZXldICYmIHR5cGVvZiBvYmpba2V5XSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIC8vIEFkZCBuZXN0ZWQga2V5cyB0byByb290XG4gICAgICBPYmplY3QuYXNzaWduKG9iaiwgeyAuLi5vYmpba2V5XSB9KTtcbiAgICAgIC8vIERlbGV0ZSBvcmlnaW5hbCBuZXN0ZWQga2V5XG4gICAgICBkZWxldGUgb2JqW2tleV07XG4gICAgfVxuICAgIHJldHVybiBvYmo7XG4gIH1cblxuICAvKipcbiAgICogRW5jb2RlcyBhIHN0cmluZyB0byBiZSB1c2VkIGluIGEgVVJMLlxuICAgKiBAcGFyYW0ge1N0cmluZ30gaW5wdXQgVGhlIHN0cmluZyB0byBlbmNvZGUuXG4gICAqIEByZXR1cm5zIHtTdHJpbmd9IFRoZSBlbmNvZGVkIHN0cmluZy5cbiAgICovXG4gIHN0YXRpYyBlbmNvZGVGb3JVcmwoaW5wdXQpIHtcbiAgICByZXR1cm4gZW5jb2RlVVJJQ29tcG9uZW50KGlucHV0KS5yZXBsYWNlKC9bIScuKCkqXS9nLCBjaGFyID0+XG4gICAgICAnJScgKyBjaGFyLmNoYXJDb2RlQXQoMCkudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKClcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBKU09OIHJlcGxhY2VyIGZ1bmN0aW9uIHRoYXQgaGFuZGxlcyBNYXAsIFNldCwgYW5kIGNpcmN1bGFyIHJlZmVyZW5jZXMuXG4gICAqIFRoaXMgcmVwbGFjZXIgY2FuIGJlIHVzZWQgd2l0aCBKU09OLnN0cmluZ2lmeSB0byBzYWZlbHkgc2VyaWFsaXplIGNvbXBsZXggb2JqZWN0cy5cbiAgICpcbiAgICogQHJldHVybnMge0Z1bmN0aW9ufSBBIHJlcGxhY2VyIGZ1bmN0aW9uIGZvciBKU09OLnN0cmluZ2lmeSB0aGF0OlxuICAgKiAtIENvbnZlcnRzIE1hcCBpbnN0YW5jZXMgdG8gcGxhaW4gb2JqZWN0c1xuICAgKiAtIENvbnZlcnRzIFNldCBpbnN0YW5jZXMgdG8gYXJyYXlzXG4gICAqIC0gUmVwbGFjZXMgY2lyY3VsYXIgcmVmZXJlbmNlcyB3aXRoICdbQ2lyY3VsYXJdJyBtYXJrZXJcbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogY29uc3Qgb2JqID0geyBuYW1lOiAndGVzdCcsIG1hcDogbmV3IE1hcChbWydrZXknLCAndmFsdWUnXV0pIH07XG4gICAqIG9iai5zZWxmID0gb2JqOyAvLyBjaXJjdWxhciByZWZlcmVuY2VcbiAgICogSlNPTi5zdHJpbmdpZnkob2JqLCBVdGlscy5nZXRDaXJjdWxhclJlcGxhY2VyKCkpO1xuICAgKiAvLyBPdXRwdXQ6IHtcIm5hbWVcIjpcInRlc3RcIixcIm1hcFwiOntcImtleVwiOlwidmFsdWVcIn0sXCJzZWxmXCI6XCJbQ2lyY3VsYXJdXCJ9XG4gICAqL1xuICBzdGF0aWMgZ2V0Q2lyY3VsYXJSZXBsYWNlcigpIHtcbiAgICBjb25zdCBzZWVuID0gbmV3IFdlYWtTZXQoKTtcbiAgICByZXR1cm4gKGtleSwgdmFsdWUpID0+IHtcbiAgICAgIGlmIChVdGlscy5pc01hcCh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyh2YWx1ZSk7XG4gICAgICB9XG4gICAgICBpZiAoVXRpbHMuaXNTZXQodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiBBcnJheS5mcm9tKHZhbHVlKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsKSB7XG4gICAgICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgICAgICByZXR1cm4gJ1tDaXJjdWxhcl0nO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEdldHMgYSBuZXN0ZWQgcHJvcGVydHkgdmFsdWUgZnJvbSBhbiBvYmplY3QgdXNpbmcgZG90IG5vdGF0aW9uLlxuICAgKiBAcGFyYW0ge09iamVjdH0gb2JqIFRoZSBvYmplY3QgdG8gZ2V0IHRoZSBwcm9wZXJ0eSBmcm9tLlxuICAgKiBAcGFyYW0ge1N0cmluZ30gcGF0aCBUaGUgcHJvcGVydHkgcGF0aCBpbiBkb3Qgbm90YXRpb24sIGUuZy4gJ2RhdGFiYXNlT3B0aW9ucy5hbGxvd1B1YmxpY0V4cGxhaW4nLlxuICAgKiBAcmV0dXJucyB7YW55fSBUaGUgcHJvcGVydHkgdmFsdWUgb3IgdW5kZWZpbmVkIGlmIG5vdCBmb3VuZC5cbiAgICogQGV4YW1wbGVcbiAgICogY29uc3Qgb2JqID0geyBkYXRhYmFzZTogeyBvcHRpb25zOiB7IGVuYWJsZWQ6IHRydWUgfSB9IH07XG4gICAqIFV0aWxzLmdldE5lc3RlZFByb3BlcnR5KG9iaiwgJ2RhdGFiYXNlLm9wdGlvbnMuZW5hYmxlZCcpO1xuICAgKiAvLyBPdXRwdXQ6IHRydWVcbiAgICovXG4gIHN0YXRpYyBnZXROZXN0ZWRQcm9wZXJ0eShvYmosIHBhdGgpIHtcbiAgICBpZiAoIW9iaiB8fCAhcGF0aCkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgY29uc3Qga2V5cyA9IHBhdGguc3BsaXQoJy4nKTtcbiAgICBsZXQgY3VycmVudCA9IG9iajtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG4gICAgICBpZiAoY3VycmVudCA9PSBudWxsIHx8IHR5cGVvZiBjdXJyZW50ICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgY3VycmVudCA9IGN1cnJlbnRba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGN1cnJlbnQ7XG4gIH1cblxuICAvKipcbiAgICogUGFyc2VzIGEgaHVtYW4tcmVhZGFibGUgc2l6ZSBzdHJpbmcgaW50byBhIGJ5dGUgY291bnQuXG4gICAqIEBwYXJhbSB7bnVtYmVyIHwgc3RyaW5nfSBzaXplIC0gQSBudW1iZXIgKGZsb29yZWQgdG8gYW4gaW50ZWdlciksIGEgbnVtZXJpYyBzdHJpbmdcbiAgICogICAodHJlYXRlZCBhcyBieXRlcyksIG9yIGEgc3RyaW5nIHdpdGggYSB1bml0IHN1ZmZpeDogYGJgLCBga2JgLCBgbWJgLCBgZ2JgXG4gICAqICAgKGNhc2UtaW5zZW5zaXRpdmUpLiBFeGFtcGxlczogYCcyMG1iJ2AsIGAnNTEya2InYCwgYCcxLjVnYidgLCBgMTA0ODU3NmAuXG4gICAqIEByZXR1cm5zIHtudW1iZXJ9IFRoZSBzaXplIGluIGJ5dGVzLCBmbG9vcmVkIHRvIHRoZSBuZWFyZXN0IGludGVnZXIuXG4gICAqIEB0aHJvd3Mge0Vycm9yfSBJZiB0aGUgc3RyaW5nIGRvZXMgbm90IG1hdGNoIHRoZSBleHBlY3RlZCBmb3JtYXQuXG4gICAqL1xuICBzdGF0aWMgcGFyc2VTaXplVG9CeXRlcyhzaXplKSB7XG4gICAgaWYgKHR5cGVvZiBzaXplID09PSAnbnVtYmVyJykge1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2l6ZSkgfHwgc2l6ZSA8IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHNpemUgdmFsdWU6ICR7c2l6ZX1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBNYXRoLmZsb29yKHNpemUpO1xuICAgIH1cbiAgICBjb25zdCBzdHIgPSBTdHJpbmcoc2l6ZSkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgY29uc3QgbWF0Y2ggPSBzdHIubWF0Y2goL14oXFxkKyg/OlxcLlxcZCspPylcXHMqKGJ8a2J8bWJ8Z2IpPyQvKTtcbiAgICBpZiAoIW1hdGNoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgc2l6ZSB2YWx1ZTogJHtzaXplfWApO1xuICAgIH1cbiAgICBjb25zdCBudW0gPSBwYXJzZUZsb2F0KG1hdGNoWzFdKTtcbiAgICBjb25zdCB1bml0ID0gbWF0Y2hbMl07XG4gICAgc3dpdGNoICh1bml0KSB7XG4gICAgICBjYXNlICdrYic6XG4gICAgICAgIHJldHVybiBNYXRoLmZsb29yKG51bSAqIDEwMjQpO1xuICAgICAgY2FzZSAnbWInOlxuICAgICAgICByZXR1cm4gTWF0aC5mbG9vcihudW0gKiAxMDI0ICogMTAyNCk7XG4gICAgICBjYXNlICdnYic6XG4gICAgICAgIHJldHVybiBNYXRoLmZsb29yKG51bSAqIDEwMjQgKiAxMDI0ICogMTAyNCk7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gTWF0aC5mbG9vcihudW0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBmaWxlIGV4dGVuc2lvbiBhcyB0aGUgc3Vic3RyaW5nIGFmdGVyIHRoZSBsYXN0IGRvdCBpbiB0aGVcbiAgICogZmlsZW5hbWUuIEEgdHJhaWxpbmcgZG90IG9yIGEgZmlsZW5hbWUgd2l0aG91dCBhIGRvdCB5aWVsZHMgYW4gZW1wdHlcbiAgICogc3RyaW5nLiBDYWxsZXJzIGFwcGx5IGFueSBmdXJ0aGVyIG5vcm1hbGl6YXRpb24gKHdoaXRlc3BhY2UsIE1JTUVcbiAgICogcGFyYW1ldGVycywgZXRjLikgZm9yIHRoZWlyIHVzZSBjYXNlIOKAlCB0aGlzIGlzIGEgcHVyZSBwYXJzZXIsIG5vdCBhXG4gICAqIHBvbGljeS5cbiAgICpcbiAgICogQHBhcmFtIHtzdHJpbmd9IGZpbGVuYW1lXG4gICAqIEByZXR1cm5zIHtzdHJpbmd9IHRoZSBleHRlbnNpb24sIG9yIGAnJ2AgaWYgbm9uZVxuICAgKi9cbiAgc3RhdGljIGdldEZpbGVFeHRlbnNpb24oZmlsZW5hbWUpIHtcbiAgICBpZiAoIWZpbGVuYW1lIHx8ICFmaWxlbmFtZS5pbmNsdWRlcygnLicpKSB7XG4gICAgICByZXR1cm4gJyc7XG4gICAgfVxuICAgIHJldHVybiBmaWxlbmFtZS5zdWJzdHJpbmcoZmlsZW5hbWUubGFzdEluZGV4T2YoJy4nKSArIDEpO1xuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gVXRpbHM7XG4iXSwibWFwcGluZ3MiOiI7O0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxNQUFNLENBQUM7QUFDNUIsTUFBTUMsRUFBRSxHQUFHRCxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUNFLFFBQVE7QUFDakMsTUFBTTtFQUFFQztBQUFNLENBQUMsR0FBR0gsT0FBTyxDQUFDLE1BQU0sQ0FBQzs7QUFFakM7QUFDQTtBQUNBO0FBQ0EsTUFBTUksS0FBSyxDQUFDO0VBQ1Y7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxhQUFhQyxnQkFBZ0JBLENBQUNDLFdBQVcsRUFBRUMsTUFBTSxFQUFFO0lBQ2pEO0lBQ0EsTUFBTUMsSUFBSSxHQUFHVCxJQUFJLENBQUNVLFFBQVEsQ0FBQ0gsV0FBVyxDQUFDO0lBQ3ZDLE1BQU1JLFFBQVEsR0FBR1gsSUFBSSxDQUFDWSxPQUFPLENBQUNMLFdBQVcsQ0FBQzs7SUFFMUM7SUFDQSxJQUFJLENBQUNDLE1BQU0sRUFBRTtNQUNYLE9BQU87UUFBRVIsSUFBSSxFQUFFTztNQUFZLENBQUM7SUFDOUI7O0lBRUE7SUFDQSxNQUFNTSxVQUFVLEdBQUdiLElBQUksQ0FBQ2MsSUFBSSxDQUFDSCxRQUFRLEVBQUVILE1BQU0sRUFBRUMsSUFBSSxDQUFDO0lBQ3BELE1BQU1NLGdCQUFnQixHQUFHLE1BQU1WLEtBQUssQ0FBQ1csVUFBVSxDQUFDSCxVQUFVLENBQUM7O0lBRTNEO0lBQ0EsSUFBSUUsZ0JBQWdCLEVBQUU7TUFDcEIsT0FBTztRQUFFZixJQUFJLEVBQUVhLFVBQVU7UUFBRUksTUFBTSxFQUFFVDtNQUFPLENBQUM7SUFDN0M7O0lBRUE7SUFDQSxNQUFNVSxRQUFRLEdBQUdWLE1BQU0sQ0FBQ1csS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNyQyxNQUFNQyxZQUFZLEdBQUdwQixJQUFJLENBQUNjLElBQUksQ0FBQ0gsUUFBUSxFQUFFTyxRQUFRLEVBQUVULElBQUksQ0FBQztJQUN4RCxNQUFNWSxrQkFBa0IsR0FBRyxNQUFNaEIsS0FBSyxDQUFDVyxVQUFVLENBQUNJLFlBQVksQ0FBQzs7SUFFL0Q7SUFDQSxJQUFJQyxrQkFBa0IsRUFBRTtNQUN0QixPQUFPO1FBQUVyQixJQUFJLEVBQUVvQixZQUFZO1FBQUVILE1BQU0sRUFBRUM7TUFBUyxDQUFDO0lBQ2pEOztJQUVBO0lBQ0EsT0FBTztNQUFFbEIsSUFBSSxFQUFFTztJQUFZLENBQUM7RUFDOUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsYUFBYVMsVUFBVUEsQ0FBQ2hCLElBQUksRUFBRTtJQUM1QixJQUFJO01BQ0YsTUFBTUUsRUFBRSxDQUFDb0IsTUFBTSxDQUFDdEIsSUFBSSxDQUFDO01BQ3JCLE9BQU8sSUFBSTtJQUNiLENBQUMsQ0FBQyxNQUFNO01BQ04sT0FBTyxLQUFLO0lBQ2Q7RUFDRjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxPQUFPdUIsTUFBTUEsQ0FBQ0MsQ0FBQyxFQUFFO0lBQ2YsT0FBTyx5QkFBeUIsQ0FBQ0MsSUFBSSxDQUFDRCxDQUFDLENBQUM7RUFDMUM7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxPQUFPRSxhQUFhQSxDQUFDQyxHQUFHLEVBQUVDLFNBQVMsRUFBRUMsU0FBUyxHQUFHLEdBQUcsRUFBRUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxFQUFFO0lBQ2pFLEtBQUssTUFBTUMsR0FBRyxJQUFJSixHQUFHLEVBQUU7TUFDckIsSUFBSUssTUFBTSxDQUFDQyxTQUFTLENBQUNDLGNBQWMsQ0FBQ0MsSUFBSSxDQUFDUixHQUFHLEVBQUVJLEdBQUcsQ0FBQyxFQUFFO1FBQ2xELE1BQU1LLE1BQU0sR0FBR1IsU0FBUyxHQUFHQSxTQUFTLEdBQUdDLFNBQVMsR0FBR0UsR0FBRyxHQUFHQSxHQUFHO1FBRTVELElBQUksT0FBT0osR0FBRyxDQUFDSSxHQUFHLENBQUMsS0FBSyxRQUFRLElBQUlKLEdBQUcsQ0FBQ0ksR0FBRyxDQUFDLEtBQUssSUFBSSxFQUFFO1VBQ3JELElBQUksQ0FBQ0wsYUFBYSxDQUFDQyxHQUFHLENBQUNJLEdBQUcsQ0FBQyxFQUFFSyxNQUFNLEVBQUVQLFNBQVMsRUFBRUMsTUFBTSxDQUFDO1FBQ3pELENBQUMsTUFBTTtVQUNMQSxNQUFNLENBQUNNLE1BQU0sQ0FBQyxHQUFHVCxHQUFHLENBQUNJLEdBQUcsQ0FBQztRQUMzQjtNQUNGO0lBQ0Y7SUFDQSxPQUFPRCxNQUFNO0VBQ2Y7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9PLE1BQU1BLENBQUNDLEtBQUssRUFBRTtJQUNuQixPQUFPbEMsS0FBSyxDQUFDaUMsTUFBTSxDQUFDQyxLQUFLLENBQUM7RUFDNUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9DLFFBQVFBLENBQUNELEtBQUssRUFBRTtJQUNyQixPQUFPbEMsS0FBSyxDQUFDbUMsUUFBUSxDQUFDRCxLQUFLLENBQUM7RUFDOUI7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9FLEtBQUtBLENBQUNGLEtBQUssRUFBRTtJQUNsQixPQUFPbEMsS0FBSyxDQUFDb0MsS0FBSyxDQUFDRixLQUFLLENBQUM7RUFDM0I7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9HLEtBQUtBLENBQUNILEtBQUssRUFBRTtJQUNsQixPQUFPbEMsS0FBSyxDQUFDcUMsS0FBSyxDQUFDSCxLQUFLLENBQUM7RUFDM0I7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9JLGFBQWFBLENBQUNKLEtBQUssRUFBRTtJQUMxQixPQUFPbEMsS0FBSyxDQUFDc0MsYUFBYSxDQUFDSixLQUFLLENBQUM7RUFDbkM7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxPQUFPSyxTQUFTQSxDQUFDTCxLQUFLLEVBQUU7SUFDdEIsSUFBSUEsS0FBSyxJQUFJLElBQUksSUFBSSxPQUFPQSxLQUFLLENBQUNNLElBQUksS0FBSyxVQUFVLEVBQUU7TUFDckQsT0FBTyxLQUFLO0lBQ2Q7SUFDQSxPQUFPWixNQUFNLENBQUNhLGNBQWMsQ0FBQ1AsS0FBSyxDQUFDLEtBQUtOLE1BQU0sQ0FBQ0MsU0FBUyxJQUFJRCxNQUFNLENBQUNDLFNBQVMsQ0FBQ0MsY0FBYyxDQUFDQyxJQUFJLENBQUNHLEtBQUssRUFBRSxNQUFNLENBQUM7RUFDakg7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsT0FBT1EsUUFBUUEsQ0FBQ1IsS0FBSyxFQUFFO0lBQ3JCLE9BQU8sT0FBT0EsS0FBSyxLQUFLLFFBQVEsSUFBSUEsS0FBSyxLQUFLLElBQUk7RUFDcEQ7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsT0FBT1Msd0JBQXdCQSxDQUFDQyxNQUFNLEVBQUVDLEtBQUssR0FBRyxDQUFDLEVBQUVDLE9BQU8sR0FBRyxDQUFDLENBQUMsRUFBRUMsT0FBTyxHQUFHLEVBQUUsRUFBRTtJQUM3RSxNQUFNQyxJQUFJLEdBQUdwQixNQUFNLENBQUNvQixJQUFJLENBQUNKLE1BQU0sQ0FBQztJQUNoQyxNQUFNakIsR0FBRyxHQUFHcUIsSUFBSSxDQUFDSCxLQUFLLENBQUM7SUFDdkIsTUFBTUksTUFBTSxHQUFHTCxNQUFNLENBQUNqQixHQUFHLENBQUM7SUFFMUIsS0FBSyxNQUFNTyxLQUFLLElBQUllLE1BQU0sRUFBRTtNQUMxQkgsT0FBTyxDQUFDbkIsR0FBRyxDQUFDLEdBQUdPLEtBQUs7TUFDcEIsTUFBTWdCLFNBQVMsR0FBR0wsS0FBSyxHQUFHLENBQUM7TUFFM0IsSUFBSUssU0FBUyxHQUFHRixJQUFJLENBQUNHLE1BQU0sRUFBRTtRQUMzQmxELEtBQUssQ0FBQzBDLHdCQUF3QixDQUFDQyxNQUFNLEVBQUVNLFNBQVMsRUFBRUosT0FBTyxFQUFFQyxPQUFPLENBQUM7TUFDckUsQ0FBQyxNQUFNO1FBQ0wsTUFBTXJCLE1BQU0sR0FBR0UsTUFBTSxDQUFDd0IsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFTixPQUFPLENBQUM7UUFDekNDLE9BQU8sQ0FBQ00sSUFBSSxDQUFDM0IsTUFBTSxDQUFDO01BQ3RCO0lBQ0Y7SUFDQSxPQUFPcUIsT0FBTztFQUNoQjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9PLGNBQWNBLENBQUNDLE1BQU0sRUFBRXZELEtBQUssRUFBRTtJQUNuQyxLQUFLLE1BQU0yQixHQUFHLElBQUlDLE1BQU0sQ0FBQ29CLElBQUksQ0FBQ08sTUFBTSxDQUFDLEVBQUU7TUFDckMsTUFBTUMsSUFBSSxHQUFHeEQsS0FBSyxDQUFDMkIsR0FBRyxDQUFDO01BQ3ZCLE1BQU04QixVQUFVLEdBQUcsQ0FBQyxDQUFDRCxJQUFJLENBQUNFLENBQUM7TUFDM0IsTUFBTUMsS0FBSyxHQUFHSixNQUFNLENBQUM1QixHQUFHLENBQUM7TUFDekIsSUFBSSxFQUFFOEIsVUFBVSxJQUFJRSxLQUFLLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQ0gsSUFBSSxDQUFDSSxDQUFDLENBQUNELEtBQUssQ0FBQyxFQUFFO1FBQ3BELE1BQU0scUJBQXFCaEMsR0FBRyxvQkFBb0I2QixJQUFJLENBQUNLLENBQUMsV0FBVyxPQUFPRixLQUFLLEVBQUU7TUFDbkY7SUFDRjtFQUNGOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9HLGtCQUFrQkEsQ0FBQ0MsSUFBSSxFQUFFQyxHQUFHLEdBQUcsSUFBSUMsSUFBSSxDQUFDLENBQUMsRUFBRTtJQUNoREYsSUFBSSxHQUFHQSxJQUFJLENBQUNHLFdBQVcsQ0FBQyxDQUFDO0lBQ3pCLElBQUlDLEtBQUssR0FBR0osSUFBSSxDQUFDaEQsS0FBSyxDQUFDLEdBQUcsQ0FBQzs7SUFFM0I7SUFDQW9ELEtBQUssR0FBR0EsS0FBSyxDQUFDQyxNQUFNLENBQUNDLElBQUksSUFBSUEsSUFBSSxLQUFLLEVBQUUsQ0FBQztJQUV6QyxNQUFNQyxNQUFNLEdBQUdILEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFJO0lBQ2hDLE1BQU1JLElBQUksR0FBR0osS0FBSyxDQUFDQSxLQUFLLENBQUNoQixNQUFNLEdBQUcsQ0FBQyxDQUFDLEtBQUssS0FBSztJQUU5QyxJQUFJLENBQUNtQixNQUFNLElBQUksQ0FBQ0MsSUFBSSxJQUFJUixJQUFJLEtBQUssS0FBSyxFQUFFO01BQ3RDLE9BQU87UUFDTFMsTUFBTSxFQUFFLE9BQU87UUFDZkMsSUFBSSxFQUFFO01BQ1IsQ0FBQztJQUNIO0lBRUEsSUFBSUgsTUFBTSxJQUFJQyxJQUFJLEVBQUU7TUFDbEIsT0FBTztRQUNMQyxNQUFNLEVBQUUsT0FBTztRQUNmQyxJQUFJLEVBQUU7TUFDUixDQUFDO0lBQ0g7O0lBRUE7SUFDQSxJQUFJSCxNQUFNLEVBQUU7TUFDVkgsS0FBSyxHQUFHQSxLQUFLLENBQUNPLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDeEIsQ0FBQyxNQUFNO01BQ0w7TUFDQVAsS0FBSyxHQUFHQSxLQUFLLENBQUNPLEtBQUssQ0FBQyxDQUFDLEVBQUVQLEtBQUssQ0FBQ2hCLE1BQU0sR0FBRyxDQUFDLENBQUM7SUFDMUM7SUFFQSxJQUFJZ0IsS0FBSyxDQUFDaEIsTUFBTSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUlZLElBQUksS0FBSyxLQUFLLEVBQUU7TUFDNUMsT0FBTztRQUNMUyxNQUFNLEVBQUUsT0FBTztRQUNmQyxJQUFJLEVBQUU7TUFDUixDQUFDO0lBQ0g7SUFFQSxNQUFNRSxLQUFLLEdBQUcsRUFBRTtJQUNoQixPQUFPUixLQUFLLENBQUNoQixNQUFNLEVBQUU7TUFDbkJ3QixLQUFLLENBQUN0QixJQUFJLENBQUMsQ0FBQ2MsS0FBSyxDQUFDUyxLQUFLLENBQUMsQ0FBQyxFQUFFVCxLQUFLLENBQUNTLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1QztJQUVBLElBQUlDLE9BQU8sR0FBRyxDQUFDO0lBQ2YsS0FBSyxNQUFNLENBQUNDLEdBQUcsRUFBRUMsUUFBUSxDQUFDLElBQUlKLEtBQUssRUFBRTtNQUNuQyxNQUFNSyxHQUFHLEdBQUdDLE1BQU0sQ0FBQ0gsR0FBRyxDQUFDO01BQ3ZCLElBQUksQ0FBQ0csTUFBTSxDQUFDQyxTQUFTLENBQUNGLEdBQUcsQ0FBQyxFQUFFO1FBQzFCLE9BQU87VUFDTFIsTUFBTSxFQUFFLE9BQU87VUFDZkMsSUFBSSxFQUFFLElBQUlLLEdBQUc7UUFDZixDQUFDO01BQ0g7TUFFQSxRQUFRQyxRQUFRO1FBQ2QsS0FBSyxJQUFJO1FBQ1QsS0FBSyxLQUFLO1FBQ1YsS0FBSyxNQUFNO1FBQ1gsS0FBSyxPQUFPO1VBQ1ZGLE9BQU8sSUFBSUcsR0FBRyxHQUFHLFFBQVEsQ0FBQyxDQUFDO1VBQzNCO1FBRUYsS0FBSyxJQUFJO1FBQ1QsS0FBSyxLQUFLO1FBQ1YsS0FBSyxNQUFNO1FBQ1gsS0FBSyxPQUFPO1VBQ1ZILE9BQU8sSUFBSUcsR0FBRyxHQUFHLE1BQU0sQ0FBQyxDQUFDO1VBQ3pCO1FBRUYsS0FBSyxHQUFHO1FBQ1IsS0FBSyxLQUFLO1FBQ1YsS0FBSyxNQUFNO1VBQ1RILE9BQU8sSUFBSUcsR0FBRyxHQUFHLEtBQUssQ0FBQyxDQUFDO1VBQ3hCO1FBRUYsS0FBSyxJQUFJO1FBQ1QsS0FBSyxLQUFLO1FBQ1YsS0FBSyxNQUFNO1FBQ1gsS0FBSyxPQUFPO1VBQ1ZILE9BQU8sSUFBSUcsR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDO1VBQ3ZCO1FBRUYsS0FBSyxLQUFLO1FBQ1YsS0FBSyxNQUFNO1FBQ1gsS0FBSyxRQUFRO1FBQ2IsS0FBSyxTQUFTO1VBQ1pILE9BQU8sSUFBSUcsR0FBRyxHQUFHLEVBQUU7VUFDbkI7UUFFRixLQUFLLEtBQUs7UUFDVixLQUFLLE1BQU07UUFDWCxLQUFLLFFBQVE7UUFDYixLQUFLLFNBQVM7VUFDWkgsT0FBTyxJQUFJRyxHQUFHO1VBQ2Q7UUFFRjtVQUNFLE9BQU87WUFDTFIsTUFBTSxFQUFFLE9BQU87WUFDZkMsSUFBSSxFQUFFLHNCQUFzQk0sUUFBUTtVQUN0QyxDQUFDO01BQ0w7SUFDRjtJQUVBLE1BQU1JLFlBQVksR0FBR04sT0FBTyxHQUFHLElBQUk7SUFDbkMsSUFBSVAsTUFBTSxFQUFFO01BQ1YsT0FBTztRQUNMRSxNQUFNLEVBQUUsU0FBUztRQUNqQkMsSUFBSSxFQUFFLFFBQVE7UUFDZC9DLE1BQU0sRUFBRSxJQUFJdUMsSUFBSSxDQUFDRCxHQUFHLENBQUNvQixPQUFPLENBQUMsQ0FBQyxHQUFHRCxZQUFZO01BQy9DLENBQUM7SUFDSCxDQUFDLE1BQU0sSUFBSVosSUFBSSxFQUFFO01BQ2YsT0FBTztRQUNMQyxNQUFNLEVBQUUsU0FBUztRQUNqQkMsSUFBSSxFQUFFLE1BQU07UUFDWi9DLE1BQU0sRUFBRSxJQUFJdUMsSUFBSSxDQUFDRCxHQUFHLENBQUNvQixPQUFPLENBQUMsQ0FBQyxHQUFHRCxZQUFZO01BQy9DLENBQUM7SUFDSCxDQUFDLE1BQU07TUFDTCxPQUFPO1FBQ0xYLE1BQU0sRUFBRSxTQUFTO1FBQ2pCQyxJQUFJLEVBQUUsU0FBUztRQUNmL0MsTUFBTSxFQUFFLElBQUl1QyxJQUFJLENBQUNELEdBQUcsQ0FBQ29CLE9BQU8sQ0FBQyxDQUFDO01BQ2hDLENBQUM7SUFDSDtFQUNGOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsT0FBT0Msc0JBQXNCQSxDQUFDOUQsR0FBRyxFQUFFSSxHQUFHLEVBQUVPLEtBQUssRUFBRTtJQUM3QyxNQUFNb0QsT0FBTyxHQUFHQSxDQUFDQyxDQUFDLEVBQUVDLENBQUMsS0FBTSxPQUFPRCxDQUFDLEtBQUssUUFBUSxJQUFJLElBQUlFLE1BQU0sQ0FBQ0QsQ0FBQyxDQUFDLENBQUNuRSxJQUFJLENBQUNrRSxDQUFDLENBQUMsSUFBS0EsQ0FBQyxLQUFLQyxDQUFDO0lBQ3JGLE1BQU1FLFVBQVUsR0FBR0MsQ0FBQyxJQUFJTCxPQUFPLENBQUNLLENBQUMsRUFBRWhFLEdBQUcsQ0FBQztJQUN2QyxNQUFNaUUsWUFBWSxHQUFHaEMsQ0FBQyxJQUFJMEIsT0FBTyxDQUFDMUIsQ0FBQyxFQUFFMUIsS0FBSyxDQUFDO0lBQzNDLE1BQU0yRCxLQUFLLEdBQUcsQ0FBQ3RFLEdBQUcsQ0FBQztJQUNuQixNQUFNdUUsSUFBSSxHQUFHLElBQUlDLE9BQU8sQ0FBQyxDQUFDO0lBQzFCLE9BQU9GLEtBQUssQ0FBQzFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7TUFDdkIsTUFBTUwsT0FBTyxHQUFHK0MsS0FBSyxDQUFDRyxHQUFHLENBQUMsQ0FBQztNQUMzQixJQUFJRixJQUFJLENBQUNHLEdBQUcsQ0FBQ25ELE9BQU8sQ0FBQyxFQUFFO1FBQ3JCO01BQ0Y7TUFDQWdELElBQUksQ0FBQ0ksR0FBRyxDQUFDcEQsT0FBTyxDQUFDO01BQ2pCLEtBQUssTUFBTSxDQUFDNkMsQ0FBQyxFQUFFL0IsQ0FBQyxDQUFDLElBQUloQyxNQUFNLENBQUN1RSxPQUFPLENBQUNyRCxPQUFPLENBQUMsRUFBRTtRQUM1QyxJQUFJbkIsR0FBRyxLQUFLeUUsU0FBUyxJQUFJbEUsS0FBSyxLQUFLa0UsU0FBUyxJQUFJVixVQUFVLENBQUNDLENBQUMsQ0FBQyxFQUFFO1VBQzdELE9BQU8sSUFBSTtRQUNiLENBQUMsTUFBTSxJQUFJaEUsR0FBRyxLQUFLeUUsU0FBUyxJQUFJbEUsS0FBSyxLQUFLa0UsU0FBUyxJQUFJUixZQUFZLENBQUNoQyxDQUFDLENBQUMsRUFBRTtVQUN0RSxPQUFPLElBQUk7UUFDYixDQUFDLE1BQU0sSUFBSWpDLEdBQUcsS0FBS3lFLFNBQVMsSUFBSWxFLEtBQUssS0FBS2tFLFNBQVMsSUFBSVYsVUFBVSxDQUFDQyxDQUFDLENBQUMsSUFBSUMsWUFBWSxDQUFDaEMsQ0FBQyxDQUFDLEVBQUU7VUFDdkYsT0FBTyxJQUFJO1FBQ2I7UUFDQSxJQUFJLENBQUMsaUJBQWlCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQ3lDLFFBQVEsQ0FBQ3pFLE1BQU0sQ0FBQ0MsU0FBUyxDQUFDeUUsUUFBUSxDQUFDdkUsSUFBSSxDQUFDNkIsQ0FBQyxDQUFDLENBQUMsRUFBRTtVQUNyRmlDLEtBQUssQ0FBQ3hDLElBQUksQ0FBQ08sQ0FBQyxDQUFDO1FBQ2Y7TUFDRjtJQUNGO0lBQ0EsT0FBTyxLQUFLO0VBQ2Q7RUFFQSxPQUFPMkMsdUJBQXVCQSxDQUFDQyxNQUFNLEVBQUVDLElBQUksRUFBRTtJQUMzQyxJQUFJRCxNQUFNLEVBQUVFLHNCQUFzQixFQUFFO01BQ2xDO01BQ0EsS0FBSyxNQUFNQyxPQUFPLElBQUlILE1BQU0sQ0FBQ0Usc0JBQXNCLEVBQUU7UUFDbkQsTUFBTUUsS0FBSyxHQUFHM0csS0FBSyxDQUFDb0Ysc0JBQXNCLENBQUNvQixJQUFJLEVBQUVFLE9BQU8sQ0FBQ2hGLEdBQUcsRUFBRWdGLE9BQU8sQ0FBQ3pFLEtBQUssQ0FBQztRQUM1RSxJQUFJMEUsS0FBSyxFQUFFO1VBQ1QsTUFBTSx1Q0FBdUNDLElBQUksQ0FBQ0MsU0FBUyxDQUFDSCxPQUFPLENBQUMsR0FBRztRQUN6RTtNQUNGO0lBQ0Y7RUFDRjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU9JLG1CQUFtQkEsQ0FBQ3hGLEdBQUcsRUFBRUksR0FBRyxFQUFFO0lBQ25DLElBQUlKLEdBQUcsQ0FBQ0ksR0FBRyxDQUFDLElBQUksT0FBT0osR0FBRyxDQUFDSSxHQUFHLENBQUMsS0FBSyxRQUFRLEVBQUU7TUFDNUM7TUFDQUMsTUFBTSxDQUFDd0IsTUFBTSxDQUFDN0IsR0FBRyxFQUFFO1FBQUUsR0FBR0EsR0FBRyxDQUFDSSxHQUFHO01BQUUsQ0FBQyxDQUFDO01BQ25DO01BQ0EsT0FBT0osR0FBRyxDQUFDSSxHQUFHLENBQUM7SUFDakI7SUFDQSxPQUFPSixHQUFHO0VBQ1o7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtFQUNFLE9BQU95RixZQUFZQSxDQUFDQyxLQUFLLEVBQUU7SUFDekIsT0FBT0Msa0JBQWtCLENBQUNELEtBQUssQ0FBQyxDQUFDRSxPQUFPLENBQUMsV0FBVyxFQUFFQyxJQUFJLElBQ3hELEdBQUcsR0FBR0EsSUFBSSxDQUFDQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUNmLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQ2dCLFdBQVcsQ0FBQyxDQUNwRCxDQUFDO0VBQ0g7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsT0FBT0MsbUJBQW1CQSxDQUFBLEVBQUc7SUFDM0IsTUFBTXpCLElBQUksR0FBRyxJQUFJQyxPQUFPLENBQUMsQ0FBQztJQUMxQixPQUFPLENBQUNwRSxHQUFHLEVBQUVPLEtBQUssS0FBSztNQUNyQixJQUFJakMsS0FBSyxDQUFDbUMsS0FBSyxDQUFDRixLQUFLLENBQUMsRUFBRTtRQUN0QixPQUFPTixNQUFNLENBQUM0RixXQUFXLENBQUN0RixLQUFLLENBQUM7TUFDbEM7TUFDQSxJQUFJakMsS0FBSyxDQUFDb0MsS0FBSyxDQUFDSCxLQUFLLENBQUMsRUFBRTtRQUN0QixPQUFPdUYsS0FBSyxDQUFDQyxJQUFJLENBQUN4RixLQUFLLENBQUM7TUFDMUI7TUFDQSxJQUFJLE9BQU9BLEtBQUssS0FBSyxRQUFRLElBQUlBLEtBQUssS0FBSyxJQUFJLEVBQUU7UUFDL0MsSUFBSTRELElBQUksQ0FBQ0csR0FBRyxDQUFDL0QsS0FBSyxDQUFDLEVBQUU7VUFDbkIsT0FBTyxZQUFZO1FBQ3JCO1FBQ0E0RCxJQUFJLENBQUNJLEdBQUcsQ0FBQ2hFLEtBQUssQ0FBQztNQUNqQjtNQUNBLE9BQU9BLEtBQUs7SUFDZCxDQUFDO0VBQ0g7O0VBRUE7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxPQUFPeUYsaUJBQWlCQSxDQUFDcEcsR0FBRyxFQUFFM0IsSUFBSSxFQUFFO0lBQ2xDLElBQUksQ0FBQzJCLEdBQUcsSUFBSSxDQUFDM0IsSUFBSSxFQUFFO01BQ2pCLE9BQU93RyxTQUFTO0lBQ2xCO0lBQ0EsTUFBTXBELElBQUksR0FBR3BELElBQUksQ0FBQ21CLEtBQUssQ0FBQyxHQUFHLENBQUM7SUFDNUIsSUFBSStCLE9BQU8sR0FBR3ZCLEdBQUc7SUFDakIsS0FBSyxNQUFNSSxHQUFHLElBQUlxQixJQUFJLEVBQUU7TUFDdEIsSUFBSUYsT0FBTyxJQUFJLElBQUksSUFBSSxPQUFPQSxPQUFPLEtBQUssUUFBUSxFQUFFO1FBQ2xELE9BQU9zRCxTQUFTO01BQ2xCO01BQ0F0RCxPQUFPLEdBQUdBLE9BQU8sQ0FBQ25CLEdBQUcsQ0FBQztJQUN4QjtJQUNBLE9BQU9tQixPQUFPO0VBQ2hCOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRSxPQUFPOEUsZ0JBQWdCQSxDQUFDQyxJQUFJLEVBQUU7SUFDNUIsSUFBSSxPQUFPQSxJQUFJLEtBQUssUUFBUSxFQUFFO01BQzVCLElBQUksQ0FBQzVDLE1BQU0sQ0FBQzZDLFFBQVEsQ0FBQ0QsSUFBSSxDQUFDLElBQUlBLElBQUksR0FBRyxDQUFDLEVBQUU7UUFDdEMsTUFBTSxJQUFJRSxLQUFLLENBQUMsdUJBQXVCRixJQUFJLEVBQUUsQ0FBQztNQUNoRDtNQUNBLE9BQU9HLElBQUksQ0FBQ0MsS0FBSyxDQUFDSixJQUFJLENBQUM7SUFDekI7SUFDQSxNQUFNSyxHQUFHLEdBQUdDLE1BQU0sQ0FBQ04sSUFBSSxDQUFDLENBQUNPLElBQUksQ0FBQyxDQUFDLENBQUNsRSxXQUFXLENBQUMsQ0FBQztJQUM3QyxNQUFNMEMsS0FBSyxHQUFHc0IsR0FBRyxDQUFDdEIsS0FBSyxDQUFDLG1DQUFtQyxDQUFDO0lBQzVELElBQUksQ0FBQ0EsS0FBSyxFQUFFO01BQ1YsTUFBTSxJQUFJbUIsS0FBSyxDQUFDLHVCQUF1QkYsSUFBSSxFQUFFLENBQUM7SUFDaEQ7SUFDQSxNQUFNL0MsR0FBRyxHQUFHdUQsVUFBVSxDQUFDekIsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2hDLE1BQU0wQixJQUFJLEdBQUcxQixLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JCLFFBQVEwQixJQUFJO01BQ1YsS0FBSyxJQUFJO1FBQ1AsT0FBT04sSUFBSSxDQUFDQyxLQUFLLENBQUNuRCxHQUFHLEdBQUcsSUFBSSxDQUFDO01BQy9CLEtBQUssSUFBSTtRQUNQLE9BQU9rRCxJQUFJLENBQUNDLEtBQUssQ0FBQ25ELEdBQUcsR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDO01BQ3RDLEtBQUssSUFBSTtRQUNQLE9BQU9rRCxJQUFJLENBQUNDLEtBQUssQ0FBQ25ELEdBQUcsR0FBRyxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUksQ0FBQztNQUM3QztRQUNFLE9BQU9rRCxJQUFJLENBQUNDLEtBQUssQ0FBQ25ELEdBQUcsQ0FBQztJQUMxQjtFQUNGOztFQUVBO0FBQ0Y7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0VBQ0UsT0FBT3lELGdCQUFnQkEsQ0FBQ0MsUUFBUSxFQUFFO0lBQ2hDLElBQUksQ0FBQ0EsUUFBUSxJQUFJLENBQUNBLFFBQVEsQ0FBQ25DLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFBRTtNQUN4QyxPQUFPLEVBQUU7SUFDWDtJQUNBLE9BQU9tQyxRQUFRLENBQUNDLFNBQVMsQ0FBQ0QsUUFBUSxDQUFDRSxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0VBQzFEO0FBQ0Y7QUFFQUMsTUFBTSxDQUFDQyxPQUFPLEdBQUczSSxLQUFLIiwiaWdub3JlTGlzdCI6W119