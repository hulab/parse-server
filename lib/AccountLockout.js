"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.AccountLockout = void 0;

var _node = _interopRequireDefault(require("parse/node"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// This class handles the Account Lockout Policy settings.
class AccountLockout {
  constructor(user, config) {
    this._user = user;
    this._config = config;
  }
  /**
   * set _failed_login_count to value
   */


  _setFailedLoginCount(value) {
    const query = {
      username: this._user.username
    };
    const updateFields = {
      _failed_login_count: value
    };
    return this._config.database.update('_User', query, updateFields);
  }
  /**
   * check if the _failed_login_count field has been set
   */


  _isFailedLoginCountSet() {
    const query = {
      username: this._user.username,
      _failed_login_count: {
        $exists: true
      }
    };
    return this._config.database.find('_User', query).then(users => {
      if (Array.isArray(users) && users.length > 0) {
        return true;
      } else {
        return false;
      }
    });
  }
  /**
   * if _failed_login_count is NOT set then set it to 0
   * else do nothing
   */


  _initFailedLoginCount() {
    return this._isFailedLoginCountSet().then(failedLoginCountIsSet => {
      if (!failedLoginCountIsSet) {
        return this._setFailedLoginCount(0);
      }
    });
  }
  /**
   * increment _failed_login_count by 1
   */


  _incrementFailedLoginCount() {
    const query = {
      username: this._user.username
    };
    const updateFields = {
      _failed_login_count: {
        __op: 'Increment',
        amount: 1
      }
    };
    return this._config.database.update('_User', query, updateFields);
  }
  /**
   * if the failed login count is greater than the threshold
   * then sets lockout expiration to 'currenttime + accountPolicy.duration', i.e., account is locked out for the next 'accountPolicy.duration' minutes
   * else do nothing
   */


  _setLockoutExpiration() {
    const query = {
      username: this._user.username,
      _failed_login_count: {
        $gte: this._config.accountLockout.threshold
      }
    };
    const now = new Date();
    const updateFields = {
      _account_lockout_expires_at: _node.default._encode(new Date(now.getTime() + this._config.accountLockout.duration * 60 * 1000))
    };
    return this._config.database.update('_User', query, updateFields).catch(err => {
      if (err && err.code && err.message && err.code === 101 && err.message.startsWith('Object not found.')) {
        return; // nothing to update so we are good
      } else {
        throw err; // unknown error
      }
    });
  }
  /**
   * if _account_lockout_expires_at > current_time and _failed_login_count > threshold
   *   reject with account locked error
   * else
   *   resolve
   */


  _notLocked() {
    const query = {
      username: this._user.username,
      _account_lockout_expires_at: {
        $gt: _node.default._encode(new Date())
      },
      _failed_login_count: {
        $gte: this._config.accountLockout.threshold
      }
    };
    return this._config.database.find('_User', query).then(users => {
      if (Array.isArray(users) && users.length > 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Your account is locked due to multiple failed login attempts. Please try again after ' + this._config.accountLockout.duration + ' minute(s)');
      }
    });
  }
  /**
   * set and/or increment _failed_login_count
   * if _failed_login_count > threshold
   *   set the _account_lockout_expires_at to current_time + accountPolicy.duration
   * else
   *   do nothing
   */


  _handleFailedLoginAttempt() {
    return this._initFailedLoginCount().then(() => {
      return this._incrementFailedLoginCount();
    }).then(() => {
      return this._setLockoutExpiration();
    });
  }
  /**
   * handle login attempt if the Account Lockout Policy is enabled
   */


  handleLoginAttempt(loginSuccessful) {
    if (!this._config.accountLockout) {
      return Promise.resolve();
    }

    return this._notLocked().then(() => {
      if (loginSuccessful) {
        return this._setFailedLoginCount(0);
      } else {
        return this._handleFailedLoginAttempt();
      }
    });
  }

}

exports.AccountLockout = AccountLockout;
var _default = AccountLockout;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9BY2NvdW50TG9ja291dC5qcyJdLCJuYW1lcyI6WyJBY2NvdW50TG9ja291dCIsImNvbnN0cnVjdG9yIiwidXNlciIsImNvbmZpZyIsIl91c2VyIiwiX2NvbmZpZyIsIl9zZXRGYWlsZWRMb2dpbkNvdW50IiwidmFsdWUiLCJxdWVyeSIsInVzZXJuYW1lIiwidXBkYXRlRmllbGRzIiwiX2ZhaWxlZF9sb2dpbl9jb3VudCIsImRhdGFiYXNlIiwidXBkYXRlIiwiX2lzRmFpbGVkTG9naW5Db3VudFNldCIsIiRleGlzdHMiLCJmaW5kIiwidGhlbiIsInVzZXJzIiwiQXJyYXkiLCJpc0FycmF5IiwibGVuZ3RoIiwiX2luaXRGYWlsZWRMb2dpbkNvdW50IiwiZmFpbGVkTG9naW5Db3VudElzU2V0IiwiX2luY3JlbWVudEZhaWxlZExvZ2luQ291bnQiLCJfX29wIiwiYW1vdW50IiwiX3NldExvY2tvdXRFeHBpcmF0aW9uIiwiJGd0ZSIsImFjY291bnRMb2Nrb3V0IiwidGhyZXNob2xkIiwibm93IiwiRGF0ZSIsIl9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCIsIlBhcnNlIiwiX2VuY29kZSIsImdldFRpbWUiLCJkdXJhdGlvbiIsImNhdGNoIiwiZXJyIiwiY29kZSIsIm1lc3NhZ2UiLCJzdGFydHNXaXRoIiwiX25vdExvY2tlZCIsIiRndCIsIkVycm9yIiwiT0JKRUNUX05PVF9GT1VORCIsIl9oYW5kbGVGYWlsZWRMb2dpbkF0dGVtcHQiLCJoYW5kbGVMb2dpbkF0dGVtcHQiLCJsb2dpblN1Y2Nlc3NmdWwiLCJQcm9taXNlIiwicmVzb2x2ZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUNBOzs7O0FBREE7QUFHTyxNQUFNQSxjQUFOLENBQXFCO0FBQzFCQyxFQUFBQSxXQUFXLENBQUNDLElBQUQsRUFBT0MsTUFBUCxFQUFlO0FBQ3hCLFNBQUtDLEtBQUwsR0FBYUYsSUFBYjtBQUNBLFNBQUtHLE9BQUwsR0FBZUYsTUFBZjtBQUNEO0FBRUQ7Ozs7O0FB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UDtBQUNELEtBTkksQ0FBUDtBQU9EO0FBRUQ7Ozs7O0FBR0FxQixFQUFBQSxrQkFBa0IsQ0FBQ0MsZUFBRCxFQUFrQjtBQUNsQyxRQUFJLENBQUMsS0FBSzVDLE9BQUwsQ0FBYXdCLGNBQWxCLEVBQWtDO0FBQ2hDLGFBQU9xQixPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNEOztBQUNELFdBQU8sS0FBS1IsVUFBTCxHQUFrQjFCLElBQWxCLENBQXVCLE1BQU07QUFDbEMsVUFBSWdDLGVBQUosRUFBcUI7QUFDbkIsZUFBTyxLQUFLM0Msb0JBQUwsQ0FBMEIsQ0FBMUIsQ0FBUDtBQUNELE9BRkQsTUFFTztBQUNMLGVBQU8sS0FBS3lDLHlCQUFMLEVBQVA7QUFDRDtBQUNGLEtBTk0sQ0FBUDtBQU9EOztBQTVKeUI7OztlQStKYi9DLGMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBUaGlzIGNsYXNzIGhhbmRsZXMgdGhlIEFjY291bnQgTG9ja291dCBQb2xpY3kgc2V0dGluZ3MuXG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5cbmV4cG9ydCBjbGFzcyBBY2NvdW50TG9ja291dCB7XG4gIGNvbnN0cnVjdG9yKHVzZXIsIGNvbmZpZykge1xuICAgIHRoaXMuX3VzZXIgPSB1c2VyO1xuICAgIHRoaXMuX2NvbmZpZyA9IGNvbmZpZztcbiAgfVxuXG4gIC8qKlxuICAgKiBzZXQgX2ZhaWxlZF9sb2dpbl9jb3VudCB0byB2YWx1ZVxuICAgKi9cbiAgX3NldEZhaWxlZExvZ2luQ291bnQodmFsdWUpIHtcbiAgICBjb25zdCBxdWVyeSA9IHtcbiAgICAgIHVzZXJuYW1lOiB0aGlzLl91c2VyLnVzZXJuYW1lLFxuICAgIH07XG5cbiAgICBjb25zdCB1cGRhdGVGaWVsZHMgPSB7XG4gICAgICBfZmFpbGVkX2xvZ2luX2NvdW50OiB2YWx1ZSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIHRoaXMuX2NvbmZpZy5kYXRhYmFzZS51cGRhdGUoJ19Vc2VyJywgcXVlcnksIHVwZGF0ZUZpZWxkcyk7XG4gIH1cblxuICAvKipcbiAgICogY2hlY2sgaWYgdGhlIF9mYWlsZWRfbG9naW5fY291bnQgZmllbGQgaGFzIGJlZW4gc2V0XG4gICAqL1xuICBfaXNGYWlsZWRMb2dpbkNvdW50U2V0KCkge1xuICAgIGNvbnN0IHF1ZXJ5ID0ge1xuICAgICAgdXNlcm5hbWU6IHRoaXMuX3VzZXIudXNlcm5hbWUsXG4gICAgICBfZmFpbGVkX2xvZ2luX2NvdW50OiB7ICRleGlzdHM6IHRydWUgfSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIHRoaXMuX2NvbmZpZy5kYXRhYmFzZS5maW5kKCdfVXNlcicsIHF1ZXJ5KS50aGVuKHVzZXJzID0+IHtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHVzZXJzKSAmJiB1c2Vycy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIGlmIF9mYWlsZWRfbG9naW5fY291bnQgaXMgTk9UIHNldCB0aGVuIHNldCBpdCB0byAwXG4gICAqIGVsc2UgZG8gbm90aGluZ1xuICAgKi9cbiAgX2luaXRGYWlsZWRMb2dpbkNvdW50KCkge1xuICAgIHJldHVybiB0aGlzLl9pc0ZhaWxlZExvZ2luQ291bnRTZXQoKS50aGVuKGZhaWxlZExvZ2luQ291bnRJc1NldCA9PiB7XG4gICAgICBpZiAoIWZhaWxlZExvZ2luQ291bnRJc1NldCkge1xuICAgICAgICByZXR1cm4gdGhpcy5fc2V0RmFpbGVkTG9naW5Db3VudCgwKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBpbmNyZW1lbnQgX2ZhaWxlZF9sb2dpbl9jb3VudCBieSAxXG4gICAqL1xuICBfaW5jcmVtZW50RmFpbGVkTG9naW5Db3VudCgpIHtcbiAgICBjb25zdCBxdWVyeSA9IHtcbiAgICAgIHVzZXJuYW1lOiB0aGlzLl91c2VyLnVzZXJuYW1lLFxuICAgIH07XG5cbiAgICBjb25zdCB1cGRhdGVGaWVsZHMgPSB7XG4gICAgICBfZmFpbGVkX2xvZ2luX2NvdW50OiB7IF9fb3A6ICdJbmNyZW1lbnQnLCBhbW91bnQ6IDEgfSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIHRoaXMuX2NvbmZpZy5kYXRhYmFzZS51cGRhdGUoJ19Vc2VyJywgcXVlcnksIHVwZGF0ZUZpZWxkcyk7XG4gIH1cblxuICAvKipcbiAgICogaWYgdGhlIGZhaWxlZCBsb2dpbiBjb3VudCBpcyBncmVhdGVyIHRoYW4gdGhlIHRocmVzaG9sZFxuICAgKiB0aGVuIHNldHMgbG9ja291dCBleHBpcmF0aW9uIHRvICdjdXJyZW50dGltZSArIGFjY291bnRQb2xpY3kuZHVyYXRpb24nLCBpLmUuLCBhY2NvdW50IGlzIGxvY2tlZCBvdXQgZm9yIHRoZSBuZXh0ICdhY2NvdW50UG9saWN5LmR1cmF0aW9uJyBtaW51dGVzXG4gICAqIGVsc2UgZG8gbm90aGluZ1xuICAgKi9cbiAgX3NldExvY2tvdXRFeHBpcmF0aW9uKCkge1xuICAgIGNvbnN0IHF1ZXJ5ID0ge1xuICAgICAgdXNlcm5hbWU6IHRoaXMuX3VzZXIudXNlcm5hbWUsXG4gICAgICBfZmFpbGVkX2xvZ2luX2NvdW50OiB7ICRndGU6IHRoaXMuX2NvbmZpZy5hY2NvdW50TG9ja291dC50aHJlc2hvbGQgfSxcbiAgICB9O1xuXG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKTtcblxuICAgIGNvbnN0IHVwZGF0ZUZpZWxkcyA9IHtcbiAgICAgIF9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdDogUGFyc2UuX2VuY29kZShcbiAgICAgICAgbmV3IERhdGUobm93LmdldFRpbWUoKSArIHRoaXMuX2NvbmZpZy5hY2NvdW50TG9ja291dC5kdXJhdGlvbiAqIDYwICogMTAwMClcbiAgICAgICksXG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLl9jb25maWcuZGF0YWJhc2UudXBkYXRlKCdfVXNlcicsIHF1ZXJ5LCB1cGRhdGVGaWVsZHMpLmNhdGNoKGVyciA9PiB7XG4gICAgICBpZiAoXG4gICAgICAgIGVyciAmJlxuICAgICAgICBlcnIuY29kZSAmJlxuICAgICAgICBlcnIubWVzc2FnZSAmJlxuICAgICAgICBlcnIuY29kZSA9PT0gMTAxICYmXG4gICAgICAgIGVyci5tZXNzYWdlLnN0YXJ0c1dpdGgoJ09iamVjdCBub3QgZm91bmQuJylcbiAgICAgICkge1xuICAgICAgICByZXR1cm47IC8vIG5vdGhpbmcgdG8gdXBkYXRlIHNvIHdlIGFyZSBnb29kXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBlcnI7IC8vIHVua25vd24gZXJyb3JcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBpZiBfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQgPiBjdXJyZW50X3RpbWUgYW5kIF9mYWlsZWRfbG9naW5fY291bnQgPiB0aHJlc2hvbGRcbiAgICogICByZWplY3Qgd2l0aCBhY2NvdW50IGxvY2tlZCBlcnJvclxuICAgKiBlbHNlXG4gICAqICAgcmVzb2x2ZVxuICAgKi9cbiAgX25vdExvY2tlZCgpIHtcbiAgICBjb25zdCBxdWVyeSA9IHtcbiAgICAgIHVzZXJuYW1lOiB0aGlzLl91c2VyLnVzZXJuYW1lLFxuICAgICAgX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0OiB7ICRndDogUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKSB9LFxuICAgICAgX2ZhaWxlZF9sb2dpbl9jb3VudDogeyAkZ3RlOiB0aGlzLl9jb25maWcuYWNjb3VudExvY2tvdXQudGhyZXNob2xkIH0sXG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLl9jb25maWcuZGF0YWJhc2UuZmluZCgnX1VzZXInLCBxdWVyeSkudGhlbih1c2VycyA9PiB7XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh1c2VycykgJiYgdXNlcnMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAnWW91ciBhY2NvdW50IGlzIGxvY2tlZCBkdWUgdG8gbXVsdGlwbGUgZmFpbGVkIGxvZ2luIGF0dGVtcHRzLiBQbGVhc2UgdHJ5IGFnYWluIGFmdGVyICcgK1xuICAgICAgICAgICAgdGhpcy5fY29uZmlnLmFjY291bnRMb2Nrb3V0LmR1cmF0aW9uICtcbiAgICAgICAgICAgICcgbWludXRlKHMpJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIHNldCBhbmQvb3IgaW5jcmVtZW50IF9mYWlsZWRfbG9naW5fY291bnRcbiAgICogaWYgX2ZhaWxlZF9sb2dpbl9jb3VudCA+IHRocmVzaG9sZFxuICAgKiAgIHNldCB0aGUgX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0IHRvIGN1cnJlbnRfdGltZSArIGFjY291bnRQb2xpY3kuZHVyYXRpb25cbiAgICogZWxzZVxuICAgKiAgIGRvIG5vdGhpbmdcbiAgICovXG4gIF9oYW5kbGVGYWlsZWRMb2dpbkF0dGVtcHQoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2luaXRGYWlsZWRMb2dpbkNvdW50KClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2luY3JlbWVudEZhaWxlZExvZ2luQ291bnQoKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLl9zZXRMb2Nrb3V0RXhwaXJhdGlvbigpO1xuICAgICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogaGFuZGxlIGxvZ2luIGF0dGVtcHQgaWYgdGhlIEFjY291bnQgTG9ja291dCBQb2xpY3kgaXMgZW5hYmxlZFxuICAgKi9cbiAgaGFuZGxlTG9naW5BdHRlbXB0KGxvZ2luU3VjY2Vzc2Z1bCkge1xuICAgIGlmICghdGhpcy5fY29uZmlnLmFjY291bnRMb2Nrb3V0KSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9ub3RMb2NrZWQoKS50aGVuKCgpID0+IHtcbiAgICAgIGlmIChsb2dpblN1Y2Nlc3NmdWwpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NldEZhaWxlZExvZ2luQ291bnQoMCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gdGhpcy5faGFuZGxlRmFpbGVkTG9naW5BdHRlbXB0KCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgQWNjb3VudExvY2tvdXQ7XG4iXX0=