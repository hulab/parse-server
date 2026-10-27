"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.UserController = void 0;
var _cryptoUtils = require("../cryptoUtils");
var _triggers = require("../triggers");
var _AdaptableController = _interopRequireDefault(require("./AdaptableController"));
var _MailAdapter = _interopRequireDefault(require("../Adapters/Email/MailAdapter"));
var _rest = _interopRequireDefault(require("../rest"));
var _node = _interopRequireDefault(require("parse/node"));
var _AccountLockout = _interopRequireDefault(require("../AccountLockout"));
var _Config = _interopRequireDefault(require("../Config"));
var _logger = _interopRequireDefault(require("../logger"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
var RestQuery = require('../RestQuery');
var Auth = require('../Auth');
class UserController extends _AdaptableController.default {
  constructor(adapter, appId, options = {}) {
    super(adapter, appId, options);
  }
  get config() {
    return _Config.default.get(this.appId);
  }
  validateAdapter(adapter) {
    // Allow no adapter
    if (!adapter && !this.shouldVerifyEmails) {
      return;
    }
    super.validateAdapter(adapter);
  }
  expectedAdapterType() {
    return _MailAdapter.default;
  }
  get shouldVerifyEmails() {
    return (this.config || this.options).verifyUserEmails;
  }
  async setEmailVerifyToken(user, req, storage = {}) {
    const shouldSendEmail = this.shouldVerifyEmails === true || typeof this.shouldVerifyEmails === 'function' && (await Promise.resolve(this.shouldVerifyEmails(req))) === true;
    if (!shouldSendEmail) {
      return false;
    }
    storage.sendVerificationEmail = true;
    user._email_verify_token = (0, _cryptoUtils.randomString)(25);
    if (!storage.fieldsChangedByTrigger || !storage.fieldsChangedByTrigger.includes('emailVerified')) {
      user.emailVerified = false;
    }
    if (this.config.emailVerifyTokenValidityDuration) {
      user._email_verify_token_expires_at = _node.default._encode(this.config.generateEmailVerifyTokenExpiresAt());
    }
    return true;
  }
  async verifyEmail(token) {
    if (!this.shouldVerifyEmails) {
      // Trying to verify email when not enabled
      // TODO: Better error here.
      throw undefined;
    }
    const query = {
      _email_verify_token: token
    };
    const updateFields = {
      emailVerified: true,
      _email_verify_token: {
        __op: 'Delete'
      }
    };

    // if the email verify token needs to be validated then
    // add additional query params and additional fields that need to be updated
    if (this.config.emailVerifyTokenValidityDuration) {
      query.emailVerified = false;
      query._email_verify_token_expires_at = {
        $gt: _node.default._encode(new Date())
      };
      updateFields._email_verify_token_expires_at = {
        __op: 'Delete'
      };
    }
    const maintenanceAuth = Auth.maintenance(this.config);
    const restQuery = await RestQuery({
      method: RestQuery.Method.get,
      config: this.config,
      auth: maintenanceAuth,
      className: '_User',
      restWhere: query
    });
    const result = await restQuery.execute();
    if (result.results.length) {
      query.objectId = result.results[0].objectId;
    }
    return await _rest.default.update(this.config, maintenanceAuth, '_User', query, updateFields);
  }
  async checkResetTokenValidity(token) {
    const results = await this.config.database.find('_User', {
      _perishable_token: token
    }, {
      limit: 1
    }, Auth.maintenance(this.config));
    if (results.length !== 1) {
      throw 'Failed to reset password: username / email / token is invalid';
    }
    if (this.config.passwordPolicy && this.config.passwordPolicy.resetTokenValidityDuration) {
      let expiresDate = results[0]._perishable_token_expires_at;
      if (expiresDate && expiresDate.__type == 'Date') {
        expiresDate = new Date(expiresDate.iso);
      }
      if (expiresDate < new Date()) {
        throw 'The password reset link has expired';
      }
    }
    return results[0];
  }
  async getUserIfNeeded(user) {
    var where = {};
    if (user.username) {
      where.username = user.username;
    }
    if (user.email) {
      where.email = user.email;
    }
    if (user._email_verify_token) {
      where._email_verify_token = user._email_verify_token;
    }
    var query = await RestQuery({
      method: RestQuery.Method.get,
      config: this.config,
      runBeforeFind: false,
      auth: Auth.master(this.config),
      className: '_User',
      restWhere: where
    });
    const result = await query.execute();
    if (result.results.length != 1) {
      throw undefined;
    }
    return result.results[0];
  }

  // Never rejects; errors are logged
  async sendVerificationEmail(user, req) {
    try {
      if (!this.shouldVerifyEmails) {
        return;
      }
      const token = encodeURIComponent(user._email_verify_token);
      // We may need to fetch the user in case of update email; only use the `fetchedUser`
      // from this point onwards; do not use the `user` as it may not contain all fields.
      const fetchedUser = await this.getUserIfNeeded(user);
      let shouldSendEmail = this.config.sendUserEmailVerification;
      if (typeof shouldSendEmail === 'function') {
        const response = await Promise.resolve(this.config.sendUserEmailVerification({
          user: _node.default.Object.fromJSON({
            className: '_User',
            ...fetchedUser
          }),
          master: req.auth?.isMaster
        }));
        shouldSendEmail = !!response;
      }
      if (!shouldSendEmail) {
        return;
      }
      const link = buildEmailLink(this.config.verifyEmailURL, token, this.config);
      const options = {
        appName: this.config.appName,
        link: link,
        user: (0, _triggers.inflate)('_User', fetchedUser)
      };
      sendEmail('verification', () => this.adapter.sendVerificationEmail ? this.adapter.sendVerificationEmail(options) : this.adapter.sendMail(this.defaultVerificationEmail(options)));
    } catch (error) {
      logSendEmailError('verification', error);
    }
  }

  /**
   * Regenerates the given user's email verification token
   *
   * @param user
   * @returns {*}
   */
  async regenerateEmailVerifyToken(user, master, installationId, ip) {
    const {
      _email_verify_token
    } = user;
    let {
      _email_verify_token_expires_at
    } = user;
    if (_email_verify_token_expires_at && _email_verify_token_expires_at.__type === 'Date') {
      _email_verify_token_expires_at = _email_verify_token_expires_at.iso;
    }
    if (this.config.emailVerifyTokenReuseIfValid && this.config.emailVerifyTokenValidityDuration && _email_verify_token && new Date() < new Date(_email_verify_token_expires_at)) {
      return Promise.resolve(true);
    }
    const shouldSend = await this.setEmailVerifyToken(user, {
      object: _node.default.User.fromJSON(Object.assign({
        className: '_User'
      }, user)),
      master,
      installationId,
      ip,
      resendRequest: true
    });
    if (!shouldSend) {
      return;
    }
    return this.config.database.update('_User', {
      username: user.username
    }, user);
  }
  async resendVerificationEmail(username, req, token) {
    const aUser = await this.getUserIfNeeded({
      username,
      _email_verify_token: token
    });
    if (!aUser || aUser.emailVerified) {
      throw undefined;
    }
    const generate = await this.regenerateEmailVerifyToken(aUser, req.auth?.isMaster, req.auth?.installationId, req.ip);
    if (generate) {
      this.sendVerificationEmail(aUser, req);
    }
  }
  setPasswordResetToken(email) {
    const token = {
      _perishable_token: (0, _cryptoUtils.randomString)(25)
    };
    if (this.config.passwordPolicy && this.config.passwordPolicy.resetTokenValidityDuration) {
      token._perishable_token_expires_at = _node.default._encode(this.config.generatePasswordResetTokenExpiresAt());
    }
    return this.config.database.update('_User', {
      $or: [{
        email
      }, {
        username: email,
        email: {
          $exists: false
        }
      }]
    }, token, {}, true);
  }
  async sendPasswordResetEmail(email) {
    if (!this.adapter) {
      throw 'Trying to send a reset password but no adapter is set';
      //  TODO: No adapter?
    }
    let user;
    if (this.config.passwordPolicy && this.config.passwordPolicy.resetTokenReuseIfValid && this.config.passwordPolicy.resetTokenValidityDuration) {
      const results = await this.config.database.find('_User', {
        $or: [{
          email,
          _perishable_token: {
            $exists: true
          }
        }, {
          username: email,
          email: {
            $exists: false
          },
          _perishable_token: {
            $exists: true
          }
        }]
      }, {
        limit: 1
      }, Auth.maintenance(this.config));
      if (results.length == 1) {
        let expiresDate = results[0]._perishable_token_expires_at;
        if (expiresDate && expiresDate.__type == 'Date') {
          expiresDate = new Date(expiresDate.iso);
        }
        if (expiresDate > new Date()) {
          user = results[0];
        }
      }
    }
    if (!user || !user._perishable_token) {
      user = await this.setPasswordResetToken(email);
    }
    const token = encodeURIComponent(user._perishable_token);
    const link = buildEmailLink(this.config.requestResetPasswordURL, token, this.config);
    const options = {
      appName: this.config.appName,
      link: link,
      user: (0, _triggers.inflate)('_User', user)
    };
    sendEmail('password reset', () => this.adapter.sendPasswordResetEmail ? this.adapter.sendPasswordResetEmail(options) : this.adapter.sendMail(this.defaultResetPasswordEmail(options)));
    return Promise.resolve(user);
  }
  async updatePassword(token, password) {
    try {
      const rawUser = await this.checkResetTokenValidity(token);
      let user;
      try {
        user = await updateUserPassword(rawUser, password, this.config);
      } catch (error) {
        if (error && error.code === _node.default.Error.OBJECT_NOT_FOUND) {
          throw 'Failed to reset password: username / email / token is invalid';
        }
        throw error;
      }
      const accountLockoutPolicy = new _AccountLockout.default(user, this.config);
      return await accountLockoutPolicy.unlockAccount();
    } catch (error) {
      if (error && error.message) {
        // in case of Parse.Error, fail with the error message only
        return Promise.reject(error.message);
      }
      return Promise.reject(error);
    }
  }
  defaultVerificationEmail({
    link,
    user,
    appName
  }) {
    const text = 'Hi,\n\n' + 'You are being asked to confirm the e-mail address ' + user.get('email') + ' with ' + appName + '\n\n' + '' + 'Click here to confirm it:\n' + link;
    const to = user.get('email');
    const subject = 'Please verify your e-mail for ' + appName;
    return {
      text,
      to,
      subject
    };
  }
  defaultResetPasswordEmail({
    link,
    user,
    appName
  }) {
    const text = 'Hi,\n\n' + 'You requested to reset your password for ' + appName + (user.get('username') ? " (your username is '" + user.get('username') + "')" : '') + '.\n\n' + '' + 'Click here to reset it:\n' + link;
    const to = user.get('email') || user.get('username');
    const subject = 'Password Reset for ' + appName;
    return {
      text,
      to,
      subject
    };
  }
}

// Mark this private
exports.UserController = UserController;
function updateUserPassword(user, password, config) {
  return _rest.default.update(config, Auth.master(config), '_User', {
    objectId: user.objectId,
    _perishable_token: user._perishable_token
  }, {
    password: password
  }).then(() => user);
}

// Never rejects; errors are logged
async function sendEmail(name, send) {
  try {
    await send();
  } catch (error) {
    logSendEmailError(name, error);
  }
}

// Omits error properties, which may contain credentials or email content
function logSendEmailError(name, error) {
  _logger.default.error(`Failed to send ${name} email`, {
    error: error?.stack || error?.message || String(error)
  });
}
function buildEmailLink(destination, token, config) {
  token = `token=${token}`;
  if (config.parseFrameURL) {
    const destinationWithoutHost = destination.replace(config.publicServerURL, '');
    return `${config.parseFrameURL}?link=${encodeURIComponent(destinationWithoutHost)}&${token}`;
  } else {
    return `${destination}?${token}`;
  }
}
var _default = exports.default = UserController;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfY3J5cHRvVXRpbHMiLCJyZXF1aXJlIiwiX3RyaWdnZXJzIiwiX0FkYXB0YWJsZUNvbnRyb2xsZXIiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX01haWxBZGFwdGVyIiwiX3Jlc3QiLCJfbm9kZSIsIl9BY2NvdW50TG9ja291dCIsIl9Db25maWciLCJfbG9nZ2VyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUmVzdFF1ZXJ5IiwiQXV0aCIsIlVzZXJDb250cm9sbGVyIiwiQWRhcHRhYmxlQ29udHJvbGxlciIsImNvbnN0cnVjdG9yIiwiYWRhcHRlciIsImFwcElkIiwib3B0aW9ucyIsImNvbmZpZyIsIkNvbmZpZyIsImdldCIsInZhbGlkYXRlQWRhcHRlciIsInNob3VsZFZlcmlmeUVtYWlscyIsImV4cGVjdGVkQWRhcHRlclR5cGUiLCJNYWlsQWRhcHRlciIsInZlcmlmeVVzZXJFbWFpbHMiLCJzZXRFbWFpbFZlcmlmeVRva2VuIiwidXNlciIsInJlcSIsInN0b3JhZ2UiLCJzaG91bGRTZW5kRW1haWwiLCJQcm9taXNlIiwicmVzb2x2ZSIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIl9lbWFpbF92ZXJpZnlfdG9rZW4iLCJyYW5kb21TdHJpbmciLCJmaWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIiwiaW5jbHVkZXMiLCJlbWFpbFZlcmlmaWVkIiwiZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24iLCJfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQiLCJQYXJzZSIsIl9lbmNvZGUiLCJnZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW5FeHBpcmVzQXQiLCJ2ZXJpZnlFbWFpbCIsInRva2VuIiwidW5kZWZpbmVkIiwicXVlcnkiLCJ1cGRhdGVGaWVsZHMiLCJfX29wIiwiJGd0IiwiRGF0ZSIsIm1haW50ZW5hbmNlQXV0aCIsIm1haW50ZW5hbmNlIiwicmVzdFF1ZXJ5IiwibWV0aG9kIiwiTWV0aG9kIiwiYXV0aCIsImNsYXNzTmFtZSIsInJlc3RXaGVyZSIsInJlc3VsdCIsImV4ZWN1dGUiLCJyZXN1bHRzIiwibGVuZ3RoIiwib2JqZWN0SWQiLCJyZXN0IiwidXBkYXRlIiwiY2hlY2tSZXNldFRva2VuVmFsaWRpdHkiLCJkYXRhYmFzZSIsImZpbmQiLCJfcGVyaXNoYWJsZV90b2tlbiIsImxpbWl0IiwicGFzc3dvcmRQb2xpY3kiLCJyZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbiIsImV4cGlyZXNEYXRlIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsIl9fdHlwZSIsImlzbyIsImdldFVzZXJJZk5lZWRlZCIsIndoZXJlIiwidXNlcm5hbWUiLCJlbWFpbCIsInJ1bkJlZm9yZUZpbmQiLCJtYXN0ZXIiLCJlbmNvZGVVUklDb21wb25lbnQiLCJmZXRjaGVkVXNlciIsInNlbmRVc2VyRW1haWxWZXJpZmljYXRpb24iLCJyZXNwb25zZSIsIk9iamVjdCIsImZyb21KU09OIiwiaXNNYXN0ZXIiLCJsaW5rIiwiYnVpbGRFbWFpbExpbmsiLCJ2ZXJpZnlFbWFpbFVSTCIsImFwcE5hbWUiLCJpbmZsYXRlIiwic2VuZEVtYWlsIiwic2VuZE1haWwiLCJkZWZhdWx0VmVyaWZpY2F0aW9uRW1haWwiLCJlcnJvciIsImxvZ1NlbmRFbWFpbEVycm9yIiwicmVnZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW4iLCJpbnN0YWxsYXRpb25JZCIsImlwIiwiZW1haWxWZXJpZnlUb2tlblJldXNlSWZWYWxpZCIsInNob3VsZFNlbmQiLCJvYmplY3QiLCJVc2VyIiwiYXNzaWduIiwicmVzZW5kUmVxdWVzdCIsInJlc2VuZFZlcmlmaWNhdGlvbkVtYWlsIiwiYVVzZXIiLCJnZW5lcmF0ZSIsInNldFBhc3N3b3JkUmVzZXRUb2tlbiIsImdlbmVyYXRlUGFzc3dvcmRSZXNldFRva2VuRXhwaXJlc0F0IiwiJG9yIiwiJGV4aXN0cyIsInNlbmRQYXNzd29yZFJlc2V0RW1haWwiLCJyZXNldFRva2VuUmV1c2VJZlZhbGlkIiwicmVxdWVzdFJlc2V0UGFzc3dvcmRVUkwiLCJkZWZhdWx0UmVzZXRQYXNzd29yZEVtYWlsIiwidXBkYXRlUGFzc3dvcmQiLCJwYXNzd29yZCIsInJhd1VzZXIiLCJ1cGRhdGVVc2VyUGFzc3dvcmQiLCJjb2RlIiwiRXJyb3IiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiYWNjb3VudExvY2tvdXRQb2xpY3kiLCJBY2NvdW50TG9ja291dCIsInVubG9ja0FjY291bnQiLCJtZXNzYWdlIiwicmVqZWN0IiwidGV4dCIsInRvIiwic3ViamVjdCIsImV4cG9ydHMiLCJ0aGVuIiwibmFtZSIsInNlbmQiLCJsb2dnZXIiLCJzdGFjayIsIlN0cmluZyIsImRlc3RpbmF0aW9uIiwicGFyc2VGcmFtZVVSTCIsImRlc3RpbmF0aW9uV2l0aG91dEhvc3QiLCJyZXBsYWNlIiwicHVibGljU2VydmVyVVJMIiwiX2RlZmF1bHQiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvQ29udHJvbGxlcnMvVXNlckNvbnRyb2xsZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmFuZG9tU3RyaW5nIH0gZnJvbSAnLi4vY3J5cHRvVXRpbHMnO1xuaW1wb3J0IHsgaW5mbGF0ZSB9IGZyb20gJy4uL3RyaWdnZXJzJztcbmltcG9ydCBBZGFwdGFibGVDb250cm9sbGVyIGZyb20gJy4vQWRhcHRhYmxlQ29udHJvbGxlcic7XG5pbXBvcnQgTWFpbEFkYXB0ZXIgZnJvbSAnLi4vQWRhcHRlcnMvRW1haWwvTWFpbEFkYXB0ZXInO1xuaW1wb3J0IHJlc3QgZnJvbSAnLi4vcmVzdCc7XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgQWNjb3VudExvY2tvdXQgZnJvbSAnLi4vQWNjb3VudExvY2tvdXQnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi9sb2dnZXInO1xuXG52YXIgUmVzdFF1ZXJ5ID0gcmVxdWlyZSgnLi4vUmVzdFF1ZXJ5Jyk7XG52YXIgQXV0aCA9IHJlcXVpcmUoJy4uL0F1dGgnKTtcblxuZXhwb3J0IGNsYXNzIFVzZXJDb250cm9sbGVyIGV4dGVuZHMgQWRhcHRhYmxlQ29udHJvbGxlciB7XG4gIGNvbnN0cnVjdG9yKGFkYXB0ZXIsIGFwcElkLCBvcHRpb25zID0ge30pIHtcbiAgICBzdXBlcihhZGFwdGVyLCBhcHBJZCwgb3B0aW9ucyk7XG4gIH1cblxuICBnZXQgY29uZmlnKCkge1xuICAgIHJldHVybiBDb25maWcuZ2V0KHRoaXMuYXBwSWQpO1xuICB9XG5cbiAgdmFsaWRhdGVBZGFwdGVyKGFkYXB0ZXIpIHtcbiAgICAvLyBBbGxvdyBubyBhZGFwdGVyXG4gICAgaWYgKCFhZGFwdGVyICYmICF0aGlzLnNob3VsZFZlcmlmeUVtYWlscykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzdXBlci52YWxpZGF0ZUFkYXB0ZXIoYWRhcHRlcik7XG4gIH1cblxuICBleHBlY3RlZEFkYXB0ZXJUeXBlKCkge1xuICAgIHJldHVybiBNYWlsQWRhcHRlcjtcbiAgfVxuXG4gIGdldCBzaG91bGRWZXJpZnlFbWFpbHMoKSB7XG4gICAgcmV0dXJuICh0aGlzLmNvbmZpZyB8fCB0aGlzLm9wdGlvbnMpLnZlcmlmeVVzZXJFbWFpbHM7XG4gIH1cblxuICBhc3luYyBzZXRFbWFpbFZlcmlmeVRva2VuKHVzZXIsIHJlcSwgc3RvcmFnZSA9IHt9KSB7XG4gICAgY29uc3Qgc2hvdWxkU2VuZEVtYWlsID1cbiAgICAgIHRoaXMuc2hvdWxkVmVyaWZ5RW1haWxzID09PSB0cnVlIHx8XG4gICAgICAodHlwZW9mIHRoaXMuc2hvdWxkVmVyaWZ5RW1haWxzID09PSAnZnVuY3Rpb24nICYmXG4gICAgICAgIChhd2FpdCBQcm9taXNlLnJlc29sdmUodGhpcy5zaG91bGRWZXJpZnlFbWFpbHMocmVxKSkpID09PSB0cnVlKTtcbiAgICBpZiAoIXNob3VsZFNlbmRFbWFpbCkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBzdG9yYWdlLnNlbmRWZXJpZmljYXRpb25FbWFpbCA9IHRydWU7XG4gICAgdXNlci5fZW1haWxfdmVyaWZ5X3Rva2VuID0gcmFuZG9tU3RyaW5nKDI1KTtcbiAgICBpZiAoXG4gICAgICAhc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIHx8XG4gICAgICAhc3RvcmFnZS5maWVsZHNDaGFuZ2VkQnlUcmlnZ2VyLmluY2x1ZGVzKCdlbWFpbFZlcmlmaWVkJylcbiAgICApIHtcbiAgICAgIHVzZXIuZW1haWxWZXJpZmllZCA9IGZhbHNlO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNvbmZpZy5lbWFpbFZlcmlmeVRva2VuVmFsaWRpdHlEdXJhdGlvbikge1xuICAgICAgdXNlci5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgPSBQYXJzZS5fZW5jb2RlKFxuICAgICAgICB0aGlzLmNvbmZpZy5nZW5lcmF0ZUVtYWlsVmVyaWZ5VG9rZW5FeHBpcmVzQXQoKVxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBhc3luYyB2ZXJpZnlFbWFpbCh0b2tlbikge1xuICAgIGlmICghdGhpcy5zaG91bGRWZXJpZnlFbWFpbHMpIHtcbiAgICAgIC8vIFRyeWluZyB0byB2ZXJpZnkgZW1haWwgd2hlbiBub3QgZW5hYmxlZFxuICAgICAgLy8gVE9ETzogQmV0dGVyIGVycm9yIGhlcmUuXG4gICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgY29uc3QgcXVlcnkgPSB7IF9lbWFpbF92ZXJpZnlfdG9rZW46IHRva2VuIH07XG4gICAgY29uc3QgdXBkYXRlRmllbGRzID0ge1xuICAgICAgZW1haWxWZXJpZmllZDogdHJ1ZSxcbiAgICAgIF9lbWFpbF92ZXJpZnlfdG9rZW46IHsgX19vcDogJ0RlbGV0ZScgfSxcbiAgICB9O1xuXG4gICAgLy8gaWYgdGhlIGVtYWlsIHZlcmlmeSB0b2tlbiBuZWVkcyB0byBiZSB2YWxpZGF0ZWQgdGhlblxuICAgIC8vIGFkZCBhZGRpdGlvbmFsIHF1ZXJ5IHBhcmFtcyBhbmQgYWRkaXRpb25hbCBmaWVsZHMgdGhhdCBuZWVkIHRvIGJlIHVwZGF0ZWRcbiAgICBpZiAodGhpcy5jb25maWcuZW1haWxWZXJpZnlUb2tlblZhbGlkaXR5RHVyYXRpb24pIHtcbiAgICAgIHF1ZXJ5LmVtYWlsVmVyaWZpZWQgPSBmYWxzZTtcbiAgICAgIHF1ZXJ5Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCA9IHsgJGd0OiBQYXJzZS5fZW5jb2RlKG5ldyBEYXRlKCkpIH07XG5cbiAgICAgIHVwZGF0ZUZpZWxkcy5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgPSB7IF9fb3A6ICdEZWxldGUnIH07XG4gICAgfVxuICAgIGNvbnN0IG1haW50ZW5hbmNlQXV0aCA9IEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpO1xuICAgIGNvbnN0IHJlc3RRdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZ2V0LFxuICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgIGF1dGg6IG1haW50ZW5hbmNlQXV0aCxcbiAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgIHJlc3RXaGVyZTogcXVlcnksXG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN0UXVlcnkuZXhlY3V0ZSgpO1xuICAgIGlmIChyZXN1bHQucmVzdWx0cy5sZW5ndGgpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0gcmVzdWx0LnJlc3VsdHNbMF0ub2JqZWN0SWQ7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCByZXN0LnVwZGF0ZSh0aGlzLmNvbmZpZywgbWFpbnRlbmFuY2VBdXRoLCAnX1VzZXInLCBxdWVyeSwgdXBkYXRlRmllbGRzKTtcbiAgfVxuXG4gIGFzeW5jIGNoZWNrUmVzZXRUb2tlblZhbGlkaXR5KHRva2VuKSB7XG4gICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAnX1VzZXInLFxuICAgICAge1xuICAgICAgICBfcGVyaXNoYWJsZV90b2tlbjogdG9rZW4sXG4gICAgICB9LFxuICAgICAgeyBsaW1pdDogMSB9LFxuICAgICAgQXV0aC5tYWludGVuYW5jZSh0aGlzLmNvbmZpZylcbiAgICApO1xuICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPT0gMSkge1xuICAgICAgdGhyb3cgJ0ZhaWxlZCB0byByZXNldCBwYXNzd29yZDogdXNlcm5hbWUgLyBlbWFpbCAvIHRva2VuIGlzIGludmFsaWQnO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5yZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbikge1xuICAgICAgbGV0IGV4cGlyZXNEYXRlID0gcmVzdWx0c1swXS5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0O1xuICAgICAgaWYgKGV4cGlyZXNEYXRlICYmIGV4cGlyZXNEYXRlLl9fdHlwZSA9PSAnRGF0ZScpIHtcbiAgICAgICAgZXhwaXJlc0RhdGUgPSBuZXcgRGF0ZShleHBpcmVzRGF0ZS5pc28pO1xuICAgICAgfVxuICAgICAgaWYgKGV4cGlyZXNEYXRlIDwgbmV3IERhdGUoKSkge1xuICAgICAgICB0aHJvdyAnVGhlIHBhc3N3b3JkIHJlc2V0IGxpbmsgaGFzIGV4cGlyZWQnO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiByZXN1bHRzWzBdO1xuICB9XG5cbiAgYXN5bmMgZ2V0VXNlcklmTmVlZGVkKHVzZXIpIHtcbiAgICB2YXIgd2hlcmUgPSB7fTtcbiAgICBpZiAodXNlci51c2VybmFtZSkge1xuICAgICAgd2hlcmUudXNlcm5hbWUgPSB1c2VyLnVzZXJuYW1lO1xuICAgIH1cbiAgICBpZiAodXNlci5lbWFpbCkge1xuICAgICAgd2hlcmUuZW1haWwgPSB1c2VyLmVtYWlsO1xuICAgIH1cbiAgICBpZiAodXNlci5fZW1haWxfdmVyaWZ5X3Rva2VuKSB7XG4gICAgICB3aGVyZS5fZW1haWxfdmVyaWZ5X3Rva2VuID0gdXNlci5fZW1haWxfdmVyaWZ5X3Rva2VuO1xuICAgIH1cblxuICAgIHZhciBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZ2V0LFxuICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgIHJ1bkJlZm9yZUZpbmQ6IGZhbHNlLFxuICAgICAgYXV0aDogQXV0aC5tYXN0ZXIodGhpcy5jb25maWcpLFxuICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgcmVzdFdoZXJlOiB3aGVyZSxcbiAgICB9KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBxdWVyeS5leGVjdXRlKCk7XG4gICAgaWYgKHJlc3VsdC5yZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQucmVzdWx0c1swXTtcbiAgfVxuXG4gIC8vIE5ldmVyIHJlamVjdHM7IGVycm9ycyBhcmUgbG9nZ2VkXG4gIGFzeW5jIHNlbmRWZXJpZmljYXRpb25FbWFpbCh1c2VyLCByZXEpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKCF0aGlzLnNob3VsZFZlcmlmeUVtYWlscykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB0b2tlbiA9IGVuY29kZVVSSUNvbXBvbmVudCh1c2VyLl9lbWFpbF92ZXJpZnlfdG9rZW4pO1xuICAgICAgLy8gV2UgbWF5IG5lZWQgdG8gZmV0Y2ggdGhlIHVzZXIgaW4gY2FzZSBvZiB1cGRhdGUgZW1haWw7IG9ubHkgdXNlIHRoZSBgZmV0Y2hlZFVzZXJgXG4gICAgICAvLyBmcm9tIHRoaXMgcG9pbnQgb253YXJkczsgZG8gbm90IHVzZSB0aGUgYHVzZXJgIGFzIGl0IG1heSBub3QgY29udGFpbiBhbGwgZmllbGRzLlxuICAgICAgY29uc3QgZmV0Y2hlZFVzZXIgPSBhd2FpdCB0aGlzLmdldFVzZXJJZk5lZWRlZCh1c2VyKTtcbiAgICAgIGxldCBzaG91bGRTZW5kRW1haWwgPSB0aGlzLmNvbmZpZy5zZW5kVXNlckVtYWlsVmVyaWZpY2F0aW9uO1xuICAgICAgaWYgKHR5cGVvZiBzaG91bGRTZW5kRW1haWwgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBQcm9taXNlLnJlc29sdmUoXG4gICAgICAgICAgdGhpcy5jb25maWcuc2VuZFVzZXJFbWFpbFZlcmlmaWNhdGlvbih7XG4gICAgICAgICAgICB1c2VyOiBQYXJzZS5PYmplY3QuZnJvbUpTT04oeyBjbGFzc05hbWU6ICdfVXNlcicsIC4uLmZldGNoZWRVc2VyIH0pLFxuICAgICAgICAgICAgbWFzdGVyOiByZXEuYXV0aD8uaXNNYXN0ZXIsXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgICAgc2hvdWxkU2VuZEVtYWlsID0gISFyZXNwb25zZTtcbiAgICAgIH1cbiAgICAgIGlmICghc2hvdWxkU2VuZEVtYWlsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxpbmsgPSBidWlsZEVtYWlsTGluayh0aGlzLmNvbmZpZy52ZXJpZnlFbWFpbFVSTCwgdG9rZW4sIHRoaXMuY29uZmlnKTtcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSB7XG4gICAgICAgIGFwcE5hbWU6IHRoaXMuY29uZmlnLmFwcE5hbWUsXG4gICAgICAgIGxpbms6IGxpbmssXG4gICAgICAgIHVzZXI6IGluZmxhdGUoJ19Vc2VyJywgZmV0Y2hlZFVzZXIpLFxuICAgICAgfTtcbiAgICAgIHNlbmRFbWFpbCgndmVyaWZpY2F0aW9uJywgKCkgPT5cbiAgICAgICAgdGhpcy5hZGFwdGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbFxuICAgICAgICAgID8gdGhpcy5hZGFwdGVyLnNlbmRWZXJpZmljYXRpb25FbWFpbChvcHRpb25zKVxuICAgICAgICAgIDogdGhpcy5hZGFwdGVyLnNlbmRNYWlsKHRoaXMuZGVmYXVsdFZlcmlmaWNhdGlvbkVtYWlsKG9wdGlvbnMpKVxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbG9nU2VuZEVtYWlsRXJyb3IoJ3ZlcmlmaWNhdGlvbicsIGVycm9yKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVnZW5lcmF0ZXMgdGhlIGdpdmVuIHVzZXIncyBlbWFpbCB2ZXJpZmljYXRpb24gdG9rZW5cbiAgICpcbiAgICogQHBhcmFtIHVzZXJcbiAgICogQHJldHVybnMgeyp9XG4gICAqL1xuICBhc3luYyByZWdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbih1c2VyLCBtYXN0ZXIsIGluc3RhbGxhdGlvbklkLCBpcCkge1xuICAgIGNvbnN0IHsgX2VtYWlsX3ZlcmlmeV90b2tlbiB9ID0gdXNlcjtcbiAgICBsZXQgeyBfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgfSA9IHVzZXI7XG4gICAgaWYgKF9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCAmJiBfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgIF9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCA9IF9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdC5pc287XG4gICAgfVxuICAgIGlmIChcbiAgICAgIHRoaXMuY29uZmlnLmVtYWlsVmVyaWZ5VG9rZW5SZXVzZUlmVmFsaWQgJiZcbiAgICAgIHRoaXMuY29uZmlnLmVtYWlsVmVyaWZ5VG9rZW5WYWxpZGl0eUR1cmF0aW9uICYmXG4gICAgICBfZW1haWxfdmVyaWZ5X3Rva2VuICYmXG4gICAgICBuZXcgRGF0ZSgpIDwgbmV3IERhdGUoX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0KVxuICAgICkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh0cnVlKTtcbiAgICB9XG4gICAgY29uc3Qgc2hvdWxkU2VuZCA9IGF3YWl0IHRoaXMuc2V0RW1haWxWZXJpZnlUb2tlbih1c2VyLCB7XG4gICAgICBvYmplY3Q6IFBhcnNlLlVzZXIuZnJvbUpTT04oT2JqZWN0LmFzc2lnbih7IGNsYXNzTmFtZTogJ19Vc2VyJyB9LCB1c2VyKSksXG4gICAgICBtYXN0ZXIsXG4gICAgICBpbnN0YWxsYXRpb25JZCxcbiAgICAgIGlwLFxuICAgICAgcmVzZW5kUmVxdWVzdDogdHJ1ZVxuICAgIH0pO1xuICAgIGlmICghc2hvdWxkU2VuZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKCdfVXNlcicsIHsgdXNlcm5hbWU6IHVzZXIudXNlcm5hbWUgfSwgdXNlcik7XG4gIH1cblxuICBhc3luYyByZXNlbmRWZXJpZmljYXRpb25FbWFpbCh1c2VybmFtZSwgcmVxLCB0b2tlbikge1xuICAgIGNvbnN0IGFVc2VyID0gYXdhaXQgdGhpcy5nZXRVc2VySWZOZWVkZWQoeyB1c2VybmFtZSwgX2VtYWlsX3ZlcmlmeV90b2tlbjogdG9rZW4gfSk7XG4gICAgaWYgKCFhVXNlciB8fCBhVXNlci5lbWFpbFZlcmlmaWVkKSB7XG4gICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGNvbnN0IGdlbmVyYXRlID0gYXdhaXQgdGhpcy5yZWdlbmVyYXRlRW1haWxWZXJpZnlUb2tlbihhVXNlciwgcmVxLmF1dGg/LmlzTWFzdGVyLCByZXEuYXV0aD8uaW5zdGFsbGF0aW9uSWQsIHJlcS5pcCk7XG4gICAgaWYgKGdlbmVyYXRlKSB7XG4gICAgICB0aGlzLnNlbmRWZXJpZmljYXRpb25FbWFpbChhVXNlciwgcmVxKTtcbiAgICB9XG4gIH1cblxuICBzZXRQYXNzd29yZFJlc2V0VG9rZW4oZW1haWwpIHtcbiAgICBjb25zdCB0b2tlbiA9IHsgX3BlcmlzaGFibGVfdG9rZW46IHJhbmRvbVN0cmluZygyNSkgfTtcblxuICAgIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJiB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5yZXNldFRva2VuVmFsaWRpdHlEdXJhdGlvbikge1xuICAgICAgdG9rZW4uX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCA9IFBhcnNlLl9lbmNvZGUoXG4gICAgICAgIHRoaXMuY29uZmlnLmdlbmVyYXRlUGFzc3dvcmRSZXNldFRva2VuRXhwaXJlc0F0KClcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLnVwZGF0ZShcbiAgICAgICdfVXNlcicsXG4gICAgICB7ICRvcjogW3sgZW1haWwgfSwgeyB1c2VybmFtZTogZW1haWwsIGVtYWlsOiB7ICRleGlzdHM6IGZhbHNlIH0gfV0gfSxcbiAgICAgIHRva2VuLFxuICAgICAge30sXG4gICAgICB0cnVlXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHNlbmRQYXNzd29yZFJlc2V0RW1haWwoZW1haWwpIHtcbiAgICBpZiAoIXRoaXMuYWRhcHRlcikge1xuICAgICAgdGhyb3cgJ1RyeWluZyB0byBzZW5kIGEgcmVzZXQgcGFzc3dvcmQgYnV0IG5vIGFkYXB0ZXIgaXMgc2V0JztcbiAgICAgIC8vICBUT0RPOiBObyBhZGFwdGVyP1xuICAgIH1cbiAgICBsZXQgdXNlcjtcbiAgICBpZiAoXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblJldXNlSWZWYWxpZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucmVzZXRUb2tlblZhbGlkaXR5RHVyYXRpb25cbiAgICApIHtcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX1VzZXInLFxuICAgICAgICB7XG4gICAgICAgICAgJG9yOiBbXG4gICAgICAgICAgICB7IGVtYWlsLCBfcGVyaXNoYWJsZV90b2tlbjogeyAkZXhpc3RzOiB0cnVlIH0gfSxcbiAgICAgICAgICAgIHsgdXNlcm5hbWU6IGVtYWlsLCBlbWFpbDogeyAkZXhpc3RzOiBmYWxzZSB9LCBfcGVyaXNoYWJsZV90b2tlbjogeyAkZXhpc3RzOiB0cnVlIH0gfSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICB7IGxpbWl0OiAxIH0sXG4gICAgICAgIEF1dGgubWFpbnRlbmFuY2UodGhpcy5jb25maWcpXG4gICAgICApO1xuICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID09IDEpIHtcbiAgICAgICAgbGV0IGV4cGlyZXNEYXRlID0gcmVzdWx0c1swXS5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0O1xuICAgICAgICBpZiAoZXhwaXJlc0RhdGUgJiYgZXhwaXJlc0RhdGUuX190eXBlID09ICdEYXRlJykge1xuICAgICAgICAgIGV4cGlyZXNEYXRlID0gbmV3IERhdGUoZXhwaXJlc0RhdGUuaXNvKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXhwaXJlc0RhdGUgPiBuZXcgRGF0ZSgpKSB7XG4gICAgICAgICAgdXNlciA9IHJlc3VsdHNbMF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCF1c2VyIHx8ICF1c2VyLl9wZXJpc2hhYmxlX3Rva2VuKSB7XG4gICAgICB1c2VyID0gYXdhaXQgdGhpcy5zZXRQYXNzd29yZFJlc2V0VG9rZW4oZW1haWwpO1xuICAgIH1cbiAgICBjb25zdCB0b2tlbiA9IGVuY29kZVVSSUNvbXBvbmVudCh1c2VyLl9wZXJpc2hhYmxlX3Rva2VuKTtcbiAgICBjb25zdCBsaW5rID0gYnVpbGRFbWFpbExpbmsodGhpcy5jb25maWcucmVxdWVzdFJlc2V0UGFzc3dvcmRVUkwsIHRva2VuLCB0aGlzLmNvbmZpZyk7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAgICAgIGFwcE5hbWU6IHRoaXMuY29uZmlnLmFwcE5hbWUsXG4gICAgICBsaW5rOiBsaW5rLFxuICAgICAgdXNlcjogaW5mbGF0ZSgnX1VzZXInLCB1c2VyKSxcbiAgICB9O1xuXG4gICAgc2VuZEVtYWlsKCdwYXNzd29yZCByZXNldCcsICgpID0+XG4gICAgICB0aGlzLmFkYXB0ZXIuc2VuZFBhc3N3b3JkUmVzZXRFbWFpbFxuICAgICAgICA/IHRoaXMuYWRhcHRlci5zZW5kUGFzc3dvcmRSZXNldEVtYWlsKG9wdGlvbnMpXG4gICAgICAgIDogdGhpcy5hZGFwdGVyLnNlbmRNYWlsKHRoaXMuZGVmYXVsdFJlc2V0UGFzc3dvcmRFbWFpbChvcHRpb25zKSlcbiAgICApO1xuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh1c2VyKTtcbiAgfVxuXG4gIGFzeW5jIHVwZGF0ZVBhc3N3b3JkKHRva2VuLCBwYXNzd29yZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXdVc2VyID0gYXdhaXQgdGhpcy5jaGVja1Jlc2V0VG9rZW5WYWxpZGl0eSh0b2tlbik7XG4gICAgICBsZXQgdXNlcjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVzZXIgPSBhd2FpdCB1cGRhdGVVc2VyUGFzc3dvcmQocmF3VXNlciwgcGFzc3dvcmQsIHRoaXMuY29uZmlnKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgdGhyb3cgJ0ZhaWxlZCB0byByZXNldCBwYXNzd29yZDogdXNlcm5hbWUgLyBlbWFpbCAvIHRva2VuIGlzIGludmFsaWQnO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBhY2NvdW50TG9ja291dFBvbGljeSA9IG5ldyBBY2NvdW50TG9ja291dCh1c2VyLCB0aGlzLmNvbmZpZyk7XG4gICAgICByZXR1cm4gYXdhaXQgYWNjb3VudExvY2tvdXRQb2xpY3kudW5sb2NrQWNjb3VudCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgJiYgZXJyb3IubWVzc2FnZSkge1xuICAgICAgICAvLyBpbiBjYXNlIG9mIFBhcnNlLkVycm9yLCBmYWlsIHdpdGggdGhlIGVycm9yIG1lc3NhZ2Ugb25seVxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyb3IubWVzc2FnZSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyb3IpO1xuICAgIH1cbiAgfVxuXG4gIGRlZmF1bHRWZXJpZmljYXRpb25FbWFpbCh7IGxpbmssIHVzZXIsIGFwcE5hbWUgfSkge1xuICAgIGNvbnN0IHRleHQgPVxuICAgICAgJ0hpLFxcblxcbicgK1xuICAgICAgJ1lvdSBhcmUgYmVpbmcgYXNrZWQgdG8gY29uZmlybSB0aGUgZS1tYWlsIGFkZHJlc3MgJyArXG4gICAgICB1c2VyLmdldCgnZW1haWwnKSArXG4gICAgICAnIHdpdGggJyArXG4gICAgICBhcHBOYW1lICtcbiAgICAgICdcXG5cXG4nICtcbiAgICAgICcnICtcbiAgICAgICdDbGljayBoZXJlIHRvIGNvbmZpcm0gaXQ6XFxuJyArXG4gICAgICBsaW5rO1xuICAgIGNvbnN0IHRvID0gdXNlci5nZXQoJ2VtYWlsJyk7XG4gICAgY29uc3Qgc3ViamVjdCA9ICdQbGVhc2UgdmVyaWZ5IHlvdXIgZS1tYWlsIGZvciAnICsgYXBwTmFtZTtcbiAgICByZXR1cm4geyB0ZXh0LCB0bywgc3ViamVjdCB9O1xuICB9XG5cbiAgZGVmYXVsdFJlc2V0UGFzc3dvcmRFbWFpbCh7IGxpbmssIHVzZXIsIGFwcE5hbWUgfSkge1xuICAgIGNvbnN0IHRleHQgPVxuICAgICAgJ0hpLFxcblxcbicgK1xuICAgICAgJ1lvdSByZXF1ZXN0ZWQgdG8gcmVzZXQgeW91ciBwYXNzd29yZCBmb3IgJyArXG4gICAgICBhcHBOYW1lICtcbiAgICAgICh1c2VyLmdldCgndXNlcm5hbWUnKSA/IFwiICh5b3VyIHVzZXJuYW1lIGlzICdcIiArIHVzZXIuZ2V0KCd1c2VybmFtZScpICsgXCInKVwiIDogJycpICtcbiAgICAgICcuXFxuXFxuJyArXG4gICAgICAnJyArXG4gICAgICAnQ2xpY2sgaGVyZSB0byByZXNldCBpdDpcXG4nICtcbiAgICAgIGxpbms7XG4gICAgY29uc3QgdG8gPSB1c2VyLmdldCgnZW1haWwnKSB8fCB1c2VyLmdldCgndXNlcm5hbWUnKTtcbiAgICBjb25zdCBzdWJqZWN0ID0gJ1Bhc3N3b3JkIFJlc2V0IGZvciAnICsgYXBwTmFtZTtcbiAgICByZXR1cm4geyB0ZXh0LCB0bywgc3ViamVjdCB9O1xuICB9XG59XG5cbi8vIE1hcmsgdGhpcyBwcml2YXRlXG5mdW5jdGlvbiB1cGRhdGVVc2VyUGFzc3dvcmQodXNlciwgcGFzc3dvcmQsIGNvbmZpZykge1xuICByZXR1cm4gcmVzdFxuICAgIC51cGRhdGUoXG4gICAgICBjb25maWcsXG4gICAgICBBdXRoLm1hc3Rlcihjb25maWcpLFxuICAgICAgJ19Vc2VyJyxcbiAgICAgIHsgb2JqZWN0SWQ6IHVzZXIub2JqZWN0SWQsIF9wZXJpc2hhYmxlX3Rva2VuOiB1c2VyLl9wZXJpc2hhYmxlX3Rva2VuIH0sXG4gICAgICB7XG4gICAgICAgIHBhc3N3b3JkOiBwYXNzd29yZCxcbiAgICAgIH1cbiAgICApXG4gICAgLnRoZW4oKCkgPT4gdXNlcik7XG59XG5cbi8vIE5ldmVyIHJlamVjdHM7IGVycm9ycyBhcmUgbG9nZ2VkXG5hc3luYyBmdW5jdGlvbiBzZW5kRW1haWwobmFtZSwgc2VuZCkge1xuICB0cnkge1xuICAgIGF3YWl0IHNlbmQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2dTZW5kRW1haWxFcnJvcihuYW1lLCBlcnJvcik7XG4gIH1cbn1cblxuLy8gT21pdHMgZXJyb3IgcHJvcGVydGllcywgd2hpY2ggbWF5IGNvbnRhaW4gY3JlZGVudGlhbHMgb3IgZW1haWwgY29udGVudFxuZnVuY3Rpb24gbG9nU2VuZEVtYWlsRXJyb3IobmFtZSwgZXJyb3IpIHtcbiAgbG9nZ2VyLmVycm9yKGBGYWlsZWQgdG8gc2VuZCAke25hbWV9IGVtYWlsYCwge1xuICAgIGVycm9yOiBlcnJvcj8uc3RhY2sgfHwgZXJyb3I/Lm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkRW1haWxMaW5rKGRlc3RpbmF0aW9uLCB0b2tlbiwgY29uZmlnKSB7XG4gIHRva2VuID0gYHRva2VuPSR7dG9rZW59YDtcbiAgaWYgKGNvbmZpZy5wYXJzZUZyYW1lVVJMKSB7XG4gICAgY29uc3QgZGVzdGluYXRpb25XaXRob3V0SG9zdCA9IGRlc3RpbmF0aW9uLnJlcGxhY2UoY29uZmlnLnB1YmxpY1NlcnZlclVSTCwgJycpO1xuXG4gICAgcmV0dXJuIGAke2NvbmZpZy5wYXJzZUZyYW1lVVJMfT9saW5rPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGRlc3RpbmF0aW9uV2l0aG91dEhvc3QpfSYke3Rva2VufWA7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGAke2Rlc3RpbmF0aW9ufT8ke3Rva2VufWA7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgVXNlckNvbnRyb2xsZXI7XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBLElBQUFBLFlBQUEsR0FBQUMsT0FBQTtBQUNBLElBQUFDLFNBQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLG9CQUFBLEdBQUFDLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSSxZQUFBLEdBQUFELHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBSyxLQUFBLEdBQUFGLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBTSxLQUFBLEdBQUFILHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBTyxlQUFBLEdBQUFKLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBUSxPQUFBLEdBQUFMLHNCQUFBLENBQUFILE9BQUE7QUFDQSxJQUFBUyxPQUFBLEdBQUFOLHNCQUFBLENBQUFILE9BQUE7QUFBK0IsU0FBQUcsdUJBQUFPLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFFL0IsSUFBSUcsU0FBUyxHQUFHYixPQUFPLENB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