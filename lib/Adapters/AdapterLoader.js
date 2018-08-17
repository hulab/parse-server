"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.loadAdapter = loadAdapter;
/**
 * @module AdapterLoader
 */
/**
 * @static
 * Attempt to load an adapter or fallback to the default.
 * @param {Adapter} adapter an adapter
 * @param {Adapter} defaultAdapter the default adapter to load
 * @param {any} options options to pass to the contstructor
 * @returns {Object} the loaded adapter
 */
function loadAdapter(adapter, defaultAdapter, options) {
  if (!adapter) {
    if (!defaultAdapter) {
      return options;
    }
    // Load from the default adapter when no adapter is set
    return loadAdapter(defaultAdapter, undefined, options);
  } else if (typeof adapter === "function") {
    try {
      return adapter(options);
    } catch (e) {
      if (e.name === 'TypeError') {
        var Adapter = adapter;
        return new Adapter(options);
      } else {
        throw e;
      }
    }
  } else if (typeof adapter === "string") {
    /* eslint-disable */
    adapter = require(adapter);
    // If it's define as a module, get the default
    if (adapter.default) {
      adapter = adapter.default;
    }
    return loadAdapter(adapter, undefined, options);
  } else if (adapter.module) {
    return loadAdapter(adapter.module, undefined, adapter.options);
  } else if (adapter.class) {
    return loadAdapter(adapter.class, undefined, adapter.options);
  } else if (adapter.adapter) {
    return loadAdapter(adapter.adapter, undefined, adapter.options);
  }
  // return the adapter as provided
  return adapter;
}

exports.default = loadAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9BZGFwdGVycy9BZGFwdGVyTG9hZGVyLmpzIl0sIm5hbWVzIjpbImxvYWRBZGFwdGVyIiwiYWRhcHRlciIsImRlZmF1bHRBZGFwdGVyIiwib3B0aW9ucyIsInVuZGVmaW5lZCIsImUiLCJuYW1lIiwiQWRhcHRlciIsInJlcXVpcmUiLCJkZWZhdWx0IiwibW9kdWxlIiwiY2xhc3MiXSwibWFwcGluZ3MiOiI7Ozs7O1FBV2dCQSxXLEdBQUFBLFc7QUFYaEI7OztBQUdBOzs7Ozs7OztBQVFPLFNBQVNBLFdBQVQsQ0FBd0JDLE9BQXhCLEVBQWlDQyxjQUFqQyxFQUFpREMsT0FBakQsRUFBNkQ7QUFDbEUsTUFBSSxDQUFDRixPQUFMLEVBQWM7QUFDWixRQUFJLENBQUNDLGNBQUwsRUFBcUI7QUFDbkIsYUFBT0MsT0FBUDtBQUNEO0FBQ0Q7QUFDQSxXQUFPSCxZQUFZRSxjQUFaLEVBQTRCRSxTQUE1QixFQUF1Q0QsT0FBdkMsQ0FBUDtBQUNELEdBTkQsTUFNTyxJQUFJLE9BQU9GLE9BQVAsS0FBbUIsVUFBdkIsRUFBbUM7QUFDeEMsUUFBSTtBQUNGLGFBQU9BLFFBQVFFLE9BQVIsQ0FBUDtBQUNELEtBRkQsQ0FFRSxPQUFNRSxDQUFOLEVBQVM7QUFDVCxVQUFJQSxFQUFFQyxJQUFGLEtBQVcsV0FBZixFQUE0QjtBQUMxQixZQUFJQyxVQUFVTixPQUFkO0FBQ0EsZUFBTyxJQUFJTSxPQUFKLENBQVlKLE9BQVosQ0FBUDtBQUNELE9BSEQsTUFHTztBQUNMLGNBQU1FLENBQU47QUFDRDtBQUNGO0FBQ0YsR0FYTSxNQVdBLElBQUksT0FBT0osT0FBUCxLQUFtQixRQUF2QixFQUFpQztBQUN0QztBQUNBQSxjQUFVTyxRQUFRUCxPQUFSLENBQVY7QUFDQTtBQUNBLFFBQUlBLFFBQVFRLE9BQVosRUFBcUI7QUFDbkJSLGdCQUFVQSxRQUFRUSxPQUFsQjtBQUNEO0FBQ0QsV0FBT1QsWUFBWUMsT0FBWixFQUFxQkcsU0FBckIsRUFBZ0NELE9BQWhDLENBQVA7QUFDRCxHQVJNLE1BUUEsSUFBSUYsUUFBUVMsTUFBWixFQUFvQjtBQUN6QixXQUFPVixZQUFZQyxRQUFRUyxNQUFwQixFQUE0Qk4sU0FBNUIsRUFBdUNILFFBQVFFLE9BQS9DLENBQVA7QUFDRCxHQUZNLE1BRUEsSUFBSUYsUUFBUVUsS0FBWixFQUFtQjtBQUN4QixXQUFPWCxZQUFZQyxRQUFRVSxLQUFwQixFQUEyQlAsU0FBM0IsRUFBc0NILFFBQVFFLE9BQTlDLENBQVA7QUFDRCxHQUZNLE1BRUEsSUFBSUYsUUFBUUEsT0FBWixFQUFxQjtBQUMxQixXQUFPRCxZQUFZQyxRQUFRQSxPQUFwQixFQUE2QkcsU0FBN0IsRUFBd0NILFFBQVFFLE9BQWhELENBQVA7QUFDRDtBQUNEO0FBQ0EsU0FBT0YsT0FBUDtBQUNEOztrQkFFY0QsVyIsImZpbGUiOiJBZGFwdGVyTG9hZGVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbW9kdWxlIEFkYXB0ZXJMb2FkZXJcbiAqL1xuLyoqXG4gKiBAc3RhdGljXG4gKiBBdHRlbXB0IHRvIGxvYWQgYW4gYWRhcHRlciBvciBmYWxsYmFjayB0byB0aGUgZGVmYXVsdC5cbiAqIEBwYXJhbSB7QWRhcHRlcn0gYWRhcHRlciBhbiBhZGFwdGVyXG4gKiBAcGFyYW0ge0FkYXB0ZXJ9IGRlZmF1bHRBZGFwdGVyIHRoZSBkZWZhdWx0IGFkYXB0ZXIgdG8gbG9hZFxuICogQHBhcmFtIHthbnl9IG9wdGlvbnMgb3B0aW9ucyB0byBwYXNzIHRvIHRoZSBjb250c3RydWN0b3JcbiAqIEByZXR1cm5zIHtPYmplY3R9IHRoZSBsb2FkZWQgYWRhcHRlclxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZEFkYXB0ZXI8VD4oYWRhcHRlciwgZGVmYXVsdEFkYXB0ZXIsIG9wdGlvbnMpOiBUIHtcbiAgaWYgKCFhZGFwdGVyKSB7XG4gICAgaWYgKCFkZWZhdWx0QWRhcHRlcikge1xuICAgICAgcmV0dXJuIG9wdGlvbnM7XG4gICAgfVxuICAgIC8vIExvYWQgZnJvbSB0aGUgZGVmYXVsdCBhZGFwdGVyIHdoZW4gbm8gYWRhcHRlciBpcyBzZXRcbiAgICByZXR1cm4gbG9hZEFkYXB0ZXIoZGVmYXVsdEFkYXB0ZXIsIHVuZGVmaW5lZCwgb3B0aW9ucyk7XG4gIH0gZWxzZSBpZiAodHlwZW9mIGFkYXB0ZXIgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYWRhcHRlcihvcHRpb25zKTtcbiAgICB9IGNhdGNoKGUpIHtcbiAgICAgIGlmIChlLm5hbWUgPT09ICdUeXBlRXJyb3InKSB7XG4gICAgICAgIHZhciBBZGFwdGVyID0gYWRhcHRlcjtcbiAgICAgICAgcmV0dXJuIG5ldyBBZGFwdGVyKG9wdGlvbnMpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAodHlwZW9mIGFkYXB0ZXIgPT09IFwic3RyaW5nXCIpIHtcbiAgICAvKiBlc2xpbnQtZGlzYWJsZSAqL1xuICAgIGFkYXB0ZXIgPSByZXF1aXJlKGFkYXB0ZXIpO1xuICAgIC8vIElmIGl0J3MgZGVmaW5lIGFzIGEgbW9kdWxlLCBnZXQgdGhlIGRlZmF1bHRcbiAgICBpZiAoYWRhcHRlci5kZWZhdWx0KSB7XG4gICAgICBhZGFwdGVyID0gYWRhcHRlci5kZWZhdWx0O1xuICAgIH1cbiAgICByZXR1cm4gbG9hZEFkYXB0ZXIoYWRhcHRlciwgdW5kZWZpbmVkLCBvcHRpb25zKTtcbiAgfSBlbHNlIGlmIChhZGFwdGVyLm1vZHVsZSkge1xuICAgIHJldHVybiBsb2FkQWRhcHRlcihhZGFwdGVyLm1vZHVsZSwgdW5kZWZpbmVkLCBhZGFwdGVyLm9wdGlvbnMpO1xuICB9IGVsc2UgaWYgKGFkYXB0ZXIuY2xhc3MpIHtcbiAgICByZXR1cm4gbG9hZEFkYXB0ZXIoYWRhcHRlci5jbGFzcywgdW5kZWZpbmVkLCBhZGFwdGVyLm9wdGlvbnMpO1xuICB9IGVsc2UgaWYgKGFkYXB0ZXIuYWRhcHRlcikge1xuICAgIHJldHVybiBsb2FkQWRhcHRlcihhZGFwdGVyLmFkYXB0ZXIsIHVuZGVmaW5lZCwgYWRhcHRlci5vcHRpb25zKTtcbiAgfVxuICAvLyByZXR1cm4gdGhlIGFkYXB0ZXIgYXMgcHJvdmlkZWRcbiAgcmV0dXJuIGFkYXB0ZXI7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGxvYWRBZGFwdGVyO1xuIl19