"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.

var SchemaController = require('./Controllers/SchemaController');
var Parse = require('parse/node').Parse;
var logger = require('./logger').default;
const triggers = require('./triggers');
const {
  continueWhile
} = require('parse/lib/node/promiseUtils');
const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL'];
const {
  enforceRoleSecurity
} = require('./SharedRest');
const {
  createSanitizedError
} = require('./Error');

// restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   excludeKeys
//   redirectClassNameForKey
//   readPreference
//   includeReadPreference
//   subqueryReadPreference
/**
 * Use to perform a query on a class. It will run security checks and triggers.
 * @param options
 * @param options.method {RestQuery.Method} The type of query to perform
 * @param options.config {ParseServerConfiguration} The server configuration
 * @param options.auth {Auth} The auth object for the request
 * @param options.className {string} The name of the class to query
 * @param options.restWhere {object} The where object for the query
 * @param options.restOptions {object} The options object for the query
 * @param options.runAfterFind {boolean} Whether to run the afterFind trigger
 * @param options.runBeforeFind {boolean} Whether to run the beforeFind trigger
 * @param options.context {object} The context object for the query
 * @returns {Promise<_UnsafeRestQuery>} A promise that is resolved with the _UnsafeRestQuery object
 */
async function RestQuery({
  method,
  config,
  auth,
  className,
  restWhere = {},
  restOptions = {},
  runAfterFind = true,
  runBeforeFind = true,
  context
}) {
  if (![RestQuery.Method.find, RestQuery.Method.get].includes(method)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'bad query type');
  }
  const isGet = method === RestQuery.Method.get;
  enforceRoleSecurity(method, className, auth, config);
  const result = runBeforeFind ? await triggers.maybeRunQueryTrigger(triggers.Types.beforeFind, className, restWhere, restOptions, config, auth, context, isGet) : Promise.resolve({
    restWhere,
    restOptions
  });
  return new _UnsafeRestQuery(config, auth, className, result.restWhere || restWhere, result.restOptions || restOptions, runAfterFind, context, isGet);
}
RestQuery.Method = Object.freeze({
  get: 'get',
  find: 'find'
});

/**
 * _UnsafeRestQuery is meant for specific internal usage only. When you need to skip security checks or some triggers.
 * Don't use it if you don't know what you are doing.
 * @param config
 * @param auth
 * @param className
 * @param restWhere
 * @param restOptions
 * @param runAfterFind
 * @param context
 */
function _UnsafeRestQuery(config, auth, className, restWhere = {}, restOptions = {}, runAfterFind = true, context, isGet) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.runAfterFind = runAfterFind;
  this.response = null;
  this.findOptions = {};
  this.context = context || {};
  this.isGet = isGet;
  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw createSanitizedError(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token', config);
      }
      this.restWhere = {
        $and: [this.restWhere, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }
  this.doCount = false;
  this.includeAll = false;

  // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]
  this.include = [];
  let keysForInclude = '';

  // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185
  if (Object.prototype.hasOwnProperty.call(restOptions, 'keys')) {
    keysForInclude = restOptions.keys;
  }

  // If we have keys, we probably want to force some includes (n-1 level)
  // in order to exclude specific keys.
  if (Object.prototype.hasOwnProperty.call(restOptions, 'excludeKeys')) {
    keysForInclude += ',' + restOptions.excludeKeys;
  }
  if (keysForInclude.length > 0) {
    keysForInclude = keysForInclude.split(',').filter(key => {
      // At least 2 components
      return key.split('.').length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf('.'));
    }).join(',');

    // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.
    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += ',' + keysForInclude;
      }
    }
  }
  for (var option in restOptions) {
    switch (option) {
      case 'keys':
        {
          const keys = restOptions.keys.split(',').filter(key => key.length > 0).concat(AlwaysSelectedKeys);
          this.keys = Array.from(new Set(keys));
          break;
        }
      case 'excludeKeys':
        {
          const exclude = restOptions.excludeKeys.split(',').filter(k => AlwaysSelectedKeys.indexOf(k) < 0);
          this.excludeKeys = Array.from(new Set(exclude));
          break;
        }
      case 'count':
        this.doCount = true;
        break;
      case 'includeAll':
        this.includeAll = true;
        break;
      case 'explain':
      case 'hint':
      case 'distinct':
      case 'pipeline':
      case 'skip':
      case 'limit':
      case 'readPreference':
      case 'comment':
      case 'rawValues':
      case 'rawFieldNames':
        this.findOptions[option] = restOptions[option];
        break;
      case 'order':
        var fields = restOptions.order.split(',');
        this.findOptions.sort = fields.reduce((sortMap, field) => {
          field = field.trim();
          if (field === '$score' || field === '-$score') {
            sortMap.score = {
              $meta: 'textScore'
            };
          } else if (field[0] == '-') {
            sortMap[field.slice(1)] = -1;
          } else {
            sortMap[field] = 1;
          }
          return sortMap;
        }, {});
        break;
      case 'include':
        {
          const paths = restOptions.include.split(',');
          if (paths.includes('*')) {
            this.includeAll = true;
            break;
          }
          // Load the existing includes (from keys)
          const pathSet = paths.reduce((memo, path) => {
            // Split each paths on . (a.b.c -> [a,b,c])
            // reduce to create all paths
            // ([a,b,c] -> {a: true, 'a.b': true, 'a.b.c': true})
            return path.split('.').reduce((memo, path, index, parts) => {
              memo[parts.slice(0, index + 1).join('.')] = true;
              return memo;
            }, memo);
          }, {});
          this.include = Object.keys(pathSet).map(s => {
            return s.split('.');
          }).sort((a, b) => {
            return a.length - b.length; // Sort by number of components
          });
          break;
        }
      case 'redirectClassNameForKey':
        this.redirectKey = restOptions.redirectClassNameForKey;
        this.redirectClassName = null;
        break;
      case 'includeReadPreference':
      case 'subqueryReadPreference':
        break;
      default:
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad option: ' + option);
    }
  }
}

// A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions
_UnsafeRestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return this.validateQueryDepth();
  }).then(() => {
    return this.buildRestWhere();
  }).then(() => {
    return this.denyProtectedFields();
  }).then(() => {
    return this.handleIncludeAll();
  }).then(() => {
    return this.validateIncludeComplexity();
  }).then(() => {
    return this.handleExcludeKeys();
  }).then(() => {
    return this.runFind(executeOptions);
  }).then(() => {
    return this.runCount();
  }).then(() => {
    return this.handleInclude();
  }).then(() => {
    return this.runAfterFindTrigger();
  }).then(() => {
    return this.handleAuthAdapters();
  }).then(() => {
    return this.response;
  });
};
_UnsafeRestQuery.prototype.each = function (callback) {
  const {
    config,
    auth,
    className,
    restWhere,
    restOptions
  } = this;
  // if the limit is set, use it
  restOptions.limit = restOptions.limit || 100;
  restOptions.order = 'objectId';
  let finished = false;
  return continueWhile(() => {
    return !finished;
  }, async () => {
    // Safe here to use _UnsafeRestQuery because the security was already
    // checked during "await RestQuery()"
    const query = new _UnsafeRestQuery(config, auth, className, restWhere, restOptions, this.runAfterFind, this.context);
    const {
      results
    } = await query.execute();
    results.forEach(callback);
    finished = results.length < restOptions.limit;
    if (!finished) {
      restWhere.objectId = Object.assign({}, restWhere.objectId, {
        $gt: results[results.length - 1].objectId
      });
    }
  });
};
_UnsafeRestQuery.prototype.validateQueryDepth = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc || rc.queryDepth === -1) {
    return;
  }
  const maxDepth = rc.queryDepth;
  const checkDepth = (node, depth) => {
    if (depth > maxDepth) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `Query condition nesting depth exceeds maximum allowed depth of ${maxDepth}`);
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        checkDepth(item, depth);
      }
      return;
    }
    // Descend into every value so that logical operators ($or/$and/$nor) nested
    // under field-level operators (e.g. $elemMatch, $not) or plain field names are
    // still counted. Only logical operators increase the depth, which preserves the
    // documented meaning of `queryDepth`.
    for (const key of Object.keys(node)) {
      const isLogical = key === '$or' || key === '$and' || key === '$nor';
      checkDepth(node[key], isLogical ? depth + 1 : depth);
    }
  };
  checkDepth(this.restWhere, 0);
};
_UnsafeRestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.redirectClassNameForKey();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.checkSubqueryDepth();
  }).then(() => {
    return this.replaceSelect();
  }).then(() => {
    return this.replaceDontSelect();
  }).then(() => {
    return this.replaceInQuery();
  }).then(() => {
    return this.replaceNotInQuery();
  }).then(() => {
    return this.replaceEquality();
  });
};

// Uses the Auth object to get the list of roles, adds the user id
_UnsafeRestQuery.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }
  this.findOptions.acl = ['*'];
  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.findOptions.acl = this.findOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
};

// Changes the className if redirectClassNameForKey is set.
// Returns a promise.
_UnsafeRestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  }

  // We need to change the class name based on the schema
  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;

    // Re-apply security checks for the redirected class name, since the
    // checks in the constructor and in rest.find ran against the original
    // class name before the redirect.
    if (!this.auth.isMaster) {
      enforceRoleSecurity('find', this.className, this.auth, this.config);
      if (this.className === '_Session') {
        if (!this.auth.user) {
          throw createSanitizedError(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token', this.config);
        }
        this.restWhere = {
          $and: [this.restWhere, {
            user: {
              __type: 'Pointer',
              className: '_User',
              objectId: this.auth.user.id
            }
          }]
        };
      }
    }
  });
};

// Validates this operation against the allowClientClassCreation config.
_UnsafeRestQuery.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className, this.config);
      }
    });
  } else {
    return Promise.resolve();
  }
};
function transformInQuery(inQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete inQueryObject['$inQuery'];
  if (Array.isArray(inQueryObject['$in'])) {
    inQueryObject['$in'] = inQueryObject['$in'].concat(values);
  } else {
    inQueryObject['$in'] = values;
  }
}
_UnsafeRestQuery.prototype.checkSubqueryDepth = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc || rc.subqueryDepth === -1) {
    return;
  }
  const depth = this.context._subqueryDepth || 0;
  if (depth > rc.subqueryDepth) {
    const message = `Subquery nesting depth exceeds maximum allowed depth of ${rc.subqueryDepth}`;
    logger.warn(message);
    throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
  }
};

// Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.
_UnsafeRestQuery.prototype.replaceInQuery = async function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');
  if (!inQueryObject) {
    return;
  }

  // The inQuery value must have precisely two keys - where and className
  var inQueryValue = inQueryObject['$inQuery'];
  if (!inQueryValue.where || !inQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $inQuery');
  }
  const additionalOptions = {
    redirectClassNameForKey: inQueryValue.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: inQueryValue.className,
    restWhere: inQueryValue.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceInQuery();
  });
};
function transformNotInQuery(notInQueryObject, className, results) {
  var values = [];
  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }
  delete notInQueryObject['$notInQuery'];
  if (Array.isArray(notInQueryObject['$nin'])) {
    notInQueryObject['$nin'] = notInQueryObject['$nin'].concat(values);
  } else {
    notInQueryObject['$nin'] = values;
  }
}

// Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.
_UnsafeRestQuery.prototype.replaceNotInQuery = async function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');
  if (!notInQueryObject) {
    return;
  }

  // The notInQuery value must have precisely two keys - where and className
  var notInQueryValue = notInQueryObject['$notInQuery'];
  if (!notInQueryValue.where || !notInQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $notInQuery');
  }
  const additionalOptions = {
    redirectClassNameForKey: notInQueryValue.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: notInQueryValue.className,
    restWhere: notInQueryValue.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results);
    // Recurse to repeat
    return this.replaceNotInQuery();
  });
};

// Used to get the deepest object from json using dot notation.
const getDeepestObjectFromKey = (json, key, idx, src) => {
  if (key in json) {
    return json[key];
  }
  src.splice(1); // Exit Early
};
const transformSelect = (selectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }
  delete selectObject['$select'];
  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
};

// Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.
_UnsafeRestQuery.prototype.replaceSelect = async function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');
  if (!selectObject) {
    return;
  }

  // The select value must have precisely two keys - query and key
  var selectValue = selectObject['$select'];
  // iOS SDK don't send where if not set, let it pass
  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }
  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: selectValue.query.className,
    restWhere: selectValue.query.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results);
    // Keep replacing $select clauses
    return this.replaceSelect();
  });
};
const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];
  for (var result of objects) {
    values.push(key.split('.').reduce(getDeepestObjectFromKey, result));
  }
  delete dontSelectObject['$dontSelect'];
  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
};

// Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.
_UnsafeRestQuery.prototype.replaceDontSelect = async function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');
  if (!dontSelectObject) {
    return;
  }

  // The dontSelect value must have precisely two keys - query and key
  var dontSelectValue = dontSelectObject['$dontSelect'];
  if (!dontSelectValue.query || !dontSelectValue.key || typeof dontSelectValue.query !== 'object' || !dontSelectValue.query.className || Object.keys(dontSelectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $dontSelect');
  }
  const additionalOptions = {
    redirectClassNameForKey: dontSelectValue.query.redirectClassNameForKey
  };
  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  } else if (this.restOptions.readPreference) {
    additionalOptions.readPreference = this.restOptions.readPreference;
  }
  if (!this.auth.isMaster && !this.auth.isMaintenance) {
    const rc = this.config.requestComplexity;
    if (rc && rc.subqueryLimit > 0) {
      additionalOptions.limit = rc.subqueryLimit;
    }
  }
  const childContext = {
    ...this.context,
    _subqueryDepth: (this.context._subqueryDepth || 0) + 1
  };
  const subquery = await RestQuery({
    method: RestQuery.Method.find,
    config: this.config,
    auth: this.auth,
    className: dontSelectValue.query.className,
    restWhere: dontSelectValue.query.where,
    restOptions: additionalOptions,
    context: childContext
  });
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results);
    // Keep replacing $dontSelect clauses
    return this.replaceDontSelect();
  });
};
_UnsafeRestQuery.prototype.cleanResultAuthData = function (result) {
  delete result.password;
  if (result.authData) {
    Object.keys(result.authData).forEach(provider => {
      if (result.authData[provider] === null) {
        delete result.authData[provider];
      }
    });
    if (Object.keys(result.authData).length == 0) {
      delete result.authData;
    }
  }
};
const replaceEqualityConstraint = constraint => {
  if (typeof constraint !== 'object') {
    return constraint;
  }
  const equalToObject = {};
  let hasDirectConstraint = false;
  let hasOperatorConstraint = false;
  for (const key in constraint) {
    if (key.indexOf('$') !== 0) {
      hasDirectConstraint = true;
      equalToObject[key] = constraint[key];
    } else {
      hasOperatorConstraint = true;
    }
  }
  if (hasDirectConstraint && hasOperatorConstraint) {
    constraint['$eq'] = equalToObject;
    Object.keys(equalToObject).forEach(key => {
      delete constraint[key];
    });
  }
  return constraint;
};
_UnsafeRestQuery.prototype.replaceEquality = function () {
  if (typeof this.restWhere !== 'object') {
    return;
  }
  for (const key in this.restWhere) {
    this.restWhere[key] = replaceEqualityConstraint(this.restWhere[key]);
  }
};

// Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.
_UnsafeRestQuery.prototype.runFind = async function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = {
      results: []
    };
    return Promise.resolve();
  }
  const findOptions = Object.assign({}, this.findOptions);
  if (this.keys) {
    findOptions.keys = this.keys.map(key => {
      return key.split('.')[0];
    });
    // When selecting `authData` on `_User`, also add the internal auth data fields
    // (e.g. `_auth_data_facebook`) for each configured auth provider. In MongoDB,
    // `authData` is stored as individual `_auth_data_<provider>` fields, so the
    // projection for `authData` alone won't match them. Adding both ensures it
    // works across all database adapters: Mongo uses `_auth_data_*` fields,
    // Postgres uses the `authData` column directly.
    //
    // Note: When selecting `authData`, only auth data of currently configured
    // providers is returned. Auth data entries of providers that are no longer
    // configured won't be included. To return all auth data regardless of the
    // provider configuration, do not use `authData` as a selected key.
    if (this.className === '_User' && findOptions.keys.includes('authData')) {
      const providers = this.config.authDataManager.getProviders();
      for (const provider of providers) {
        const key = `_auth_data_${provider}`;
        if (!findOptions.keys.includes(key)) {
          findOptions.keys.push(key);
        }
      }
    }
  }
  if (options.op) {
    findOptions.op = options.op;
  }
  const results = await this.config.database.find(this.className, this.restWhere, findOptions, this.auth);
  if (this.className === '_User' && !findOptions.explain) {
    for (var result of results) {
      this.cleanResultAuthData(result);
    }
  }
  await this.config.filesController.expandFilesInObject(this.config, results);
  if (this.redirectClassName) {
    for (var r of results) {
      r.className = this.redirectClassName;
    }
  }
  this.response = {
    results: results
  };
};

// Returns a promise for whether it was successful.
// Populates this.response.count with the count
_UnsafeRestQuery.prototype.runCount = function () {
  if (!this.doCount) {
    return;
  }
  this.findOptions.count = true;
  delete this.findOptions.skip;
  delete this.findOptions.limit;
  return this.config.database.find(this.className, this.restWhere, this.findOptions).then(c => {
    this.response.count = c;
  });
};
_UnsafeRestQuery.prototype.denyProtectedFields = async function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const schemaController = await this.config.database.loadSchema();
  const protectedFields = this.config.database.addProtectedFields(schemaController, this.className, this.restWhere, this.findOptions.acl, this.auth, this.findOptions) || [];
  const checkWhere = where => {
    if (typeof where !== 'object' || where === null) {
      return;
    }
    for (const whereKey of Object.keys(where)) {
      const rootField = whereKey.split('.')[0];
      if (protectedFields.includes(whereKey) || protectedFields.includes(rootField)) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to query ${whereKey} on class ${this.className}`, this.config);
      }
    }
    for (const op of ['$or', '$and', '$nor']) {
      if (where[op] !== undefined && !Array.isArray(where[op])) {
        throw createSanitizedError(Parse.Error.INVALID_QUERY, `${op} must be an array`, this.config);
      }
      if (Array.isArray(where[op])) {
        where[op].forEach(subQuery => checkWhere(subQuery));
      }
    }
  };
  checkWhere(this.restWhere);

  // Check sort keys against protected fields
  if (this.findOptions.sort) {
    for (const sortKey of Object.keys(this.findOptions.sort)) {
      const rootField = sortKey.split('.')[0];
      if (protectedFields.includes(sortKey) || protectedFields.includes(rootField)) {
        throw createSanitizedError(Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to sort by ${sortKey} on class ${this.className}`, this.config);
      }
    }
  }
};

// Augments this.response with all pointers on an object
_UnsafeRestQuery.prototype.handleIncludeAll = function () {
  if (!this.includeAll) {
    return;
  }
  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const includeFields = [];
    const keyFields = [];
    for (const field in schema.fields) {
      if (schema.fields[field].type && schema.fields[field].type === 'Pointer' || schema.fields[field].type && schema.fields[field].type === 'Array') {
        includeFields.push([field]);
        keyFields.push(field);
      }
    }
    // Add fields to include, keys, remove dups
    this.include = [...new Set([...this.include, ...includeFields])];
    // if this.keys not set, then all keys are already included
    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
};
_UnsafeRestQuery.prototype.validateIncludeComplexity = function () {
  if (this.auth.isMaster || this.auth.isMaintenance) {
    return;
  }
  const rc = this.config.requestComplexity;
  if (!rc) {
    return;
  }
  if (rc.includeDepth !== -1 && this.include && this.include.length > 0) {
    const maxDepth = Math.max(...this.include.map(path => path.length));
    if (maxDepth > rc.includeDepth) {
      const message = `Include depth of ${maxDepth} exceeds maximum allowed depth of ${rc.includeDepth}`;
      logger.warn(message);
      throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
    }
  }
  if (rc.includeCount !== -1 && this.include && this.include.length > rc.includeCount) {
    const message = `Number of include fields (${this.include.length}) exceeds maximum allowed (${rc.includeCount})`;
    logger.warn(message);
    throw new Parse.Error(Parse.Error.INVALID_QUERY, message);
  }
};

// Updates property `this.keys` to contain all keys but the ones unselected.
_UnsafeRestQuery.prototype.handleExcludeKeys = function () {
  if (!this.excludeKeys) {
    return;
  }
  if (this.keys) {
    this.keys = this.keys.filter(k => !this.excludeKeys.includes(k));
    return;
  }
  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const fields = Object.keys(schema.fields);
    this.keys = fields.filter(k => !this.excludeKeys.includes(k));
  });
};

// Augments this.response with data at the paths provided in this.include.
_UnsafeRestQuery.prototype.handleInclude = async function () {
  if (this.include.length == 0) {
    return;
  }
  const indexedResults = this.response.results.reduce((indexed, result, i) => {
    indexed[result.objectId] = i;
    return indexed;
  }, {});

  // Build the execution tree
  const executionTree = {};
  this.include.forEach(path => {
    let current = executionTree;
    path.forEach(node => {
      if (!current[node]) {
        current[node] = {
          path,
          children: {}
        };
      }
      current = current[node].children;
    });
  });
  const recursiveExecutionTree = async treeNode => {
    const {
      path,
      children
    } = treeNode;
    const pathResponse = includePath(this.config, this.auth, this.response, path, this.context, this.restOptions, this);
    if (pathResponse.then) {
      const newResponse = await pathResponse;
      newResponse.results.forEach(newObject => {
        // We hydrate the root of each result with sub results
        this.response.results[indexedResults[newObject.objectId]][path[0]] = newObject[path[0]];
      });
    }
    return Promise.all(Object.values(children).map(recursiveExecutionTree));
  };
  await Promise.all(Object.values(executionTree).map(recursiveExecutionTree));
  this.include = [];
};

//Returns a promise of a processed set of results
_UnsafeRestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  }
  if (!this.runAfterFind) {
    return;
  }
  // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.
  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);
  if (!hasAfterFindHook) {
    return Promise.resolve();
  }
  // Skip Aggregate and Distinct Queries
  if (this.findOptions.pipeline || this.findOptions.distinct) {
    return Promise.resolve();
  }
  const json = Object.assign({}, this.restOptions);
  json.where = this.restWhere;
  const parseQuery = new Parse.Query(this.className);
  parseQuery.withJSON(json);
  // Run afterFind trigger and set the new results
  return triggers.maybeRunAfterFindTrigger(triggers.Types.afterFind, this.auth, this.className, this.response.results, this.config, parseQuery, this.context, this.isGet).then(results => {
    // Ensure we properly set the className back
    if (this.redirectClassName) {
      this.response.results = results.map(object => {
        if (object instanceof Parse.Object) {
          object = object.toJSON();
        }
        object.className = this.redirectClassName;
        return object;
      });
    } else {
      this.response.results = results;
    }
  });
};
_UnsafeRestQuery.prototype.handleAuthAdapters = async function () {
  if (this.className !== '_User' || this.findOptions.explain) {
    return;
  }
  await Promise.all(this.response.results.map(result => this.config.authDataManager.runAfterFind({
    config: this.config,
    auth: this.auth
  }, result.authData)));
};

// Adds included values to the response.
// Path is a list of field names.
// Returns a promise for an augmented response.
function includePath(config, auth, response, path, context, restOptions = {}) {
  var pointers = findPointers(response.results, path);
  if (pointers.length == 0) {
    return response;
  }
  const pointersHash = {};
  for (var pointer of pointers) {
    if (!pointer) {
      continue;
    }
    const className = pointer.className;
    // only include the good pointers
    if (className) {
      pointersHash[className] = pointersHash[className] || new Set();
      pointersHash[className].add(pointer.objectId);
    }
  }
  const includeRestOptions = {};
  if (restOptions.keys) {
    const keys = new Set(restOptions.keys.split(','));
    const keySet = Array.from(keys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;
      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }
      if (i < keyPath.length) {
        set.add(keyPath[i]);
      }
      return set;
    }, new Set());
    if (keySet.size > 0) {
      includeRestOptions.keys = Array.from(keySet).join(',');
    }
  }
  if (restOptions.excludeKeys) {
    const excludeKeys = new Set(restOptions.excludeKeys.split(','));
    const excludeKeySet = Array.from(excludeKeys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;
      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }
      if (i == keyPath.length - 1) {
        set.add(keyPath[i]);
      }
      return set;
    }, new Set());
    if (excludeKeySet.size > 0) {
      includeRestOptions.excludeKeys = Array.from(excludeKeySet).join(',');
    }
  }
  if (restOptions.includeReadPreference) {
    includeRestOptions.readPreference = restOptions.includeReadPreference;
    includeRestOptions.includeReadPreference = restOptions.includeReadPreference;
  } else if (restOptions.readPreference) {
    includeRestOptions.readPreference = restOptions.readPreference;
  }
  const queryPromises = Object.keys(pointersHash).map(async className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;
    if (objectIds.length === 1) {
      where = {
        objectId: objectIds[0]
      };
    } else {
      where = {
        objectId: {
          $in: objectIds
        }
      };
    }
    const query = await RestQuery({
      method: objectIds.length === 1 ? RestQuery.Method.get : RestQuery.Method.find,
      config,
      auth,
      className,
      restWhere: where,
      restOptions: includeRestOptions,
      context: context
    });
    return query.execute({
      op: 'get'
    }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  });

  // Get the objects for all these object ids
  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;
        if (obj.className == '_User' && !auth.isMaster) {
          delete obj.sessionToken;
          delete obj.authData;
        }
        replace[obj.objectId] = obj;
      }
      return replace;
    }, {});
    var resp = {
      results: replacePointers(response.results, path, replace)
    };
    if (response.count) {
      resp.count = response.count;
    }
    return resp;
  });
}

// Object may be a list of REST-format object to find pointers in, or
// it may be a single object.
// If the path yields things that aren't pointers, this throws an error.
// Path is a list of fields to search into.
// Returns a list of pointers in REST format.
function findPointers(object, path) {
  if (Array.isArray(object)) {
    return object.map(x => findPointers(x, path)).flat();
  }
  if (typeof object !== 'object' || !object) {
    return [];
  }
  if (path.length == 0) {
    if (object === null || object.__type == 'Pointer') {
      return [object];
    }
    return [];
  }
  var subobject = object[path[0]];
  if (!subobject) {
    return [];
  }
  return findPointers(subobject, path.slice(1));
}

// Object may be a list of REST-format objects to replace pointers
// in, or it may be a single object.
// Path is a list of fields to search into.
// replace is a map from object id -> object.
// Returns something analogous to object, but with the appropriate
// pointers inflated.
function replacePointers(object, path, replace) {
  if (Array.isArray(object)) {
    return object.map(obj => replacePointers(obj, path, replace)).filter(obj => typeof obj !== 'undefined');
  }
  if (typeof object !== 'object' || !object) {
    return object;
  }
  if (path.length === 0) {
    if (object && object.__type === 'Pointer') {
      return replace[object.objectId];
    }
    return object;
  }
  var subobject = object[path[0]];
  if (!subobject) {
    return object;
  }
  var newsub = replacePointers(subobject, path.slice(1), replace);
  var answer = {};
  for (var key in object) {
    if (key == path[0]) {
      answer[key] = newsub;
    } else {
      answer[key] = object[key];
    }
  }
  return answer;
}

// Finds a subobject that has the given key, if there is one.
// Returns undefined otherwise.
function findObjectWithKey(root, key) {
  if (typeof root !== 'object') {
    return;
  }
  if (Array.isArray(root)) {
    for (var item of root) {
      const answer = findObjectWithKey(item, key);
      if (answer) {
        return answer;
      }
    }
    // Arrays are fully traversed above; returning here avoids re-walking the same
    // elements through the `for (subkey in root)` loop below, which would make this
    // function O(2^n) for nested arrays (e.g. deeply nested $or/$and/$nor).
    return;
  }
  if (root && root[key]) {
    return root;
  }
  for (var subkey in root) {
    const answer = findObjectWithKey(root[subkey], key);
    if (answer) {
      return answer;
    }
  }
}
module.exports = RestQuery;
// For tests
module.exports._UnsafeRestQuery = _UnsafeRestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJTY2hlbWFDb250cm9sbGVyIiwicmVxdWlyZSIsIlBhcnNlIiwibG9nZ2VyIiwiZGVmYXVsdCIsInRyaWdnZXJzIiwiY29udGludWVXaGlsZSIsIkFsd2F5c1NlbGVjdGVkS2V5cyIsImVuZm9yY2VSb2xlU2VjdXJpdHkiLCJjcmVhdGVTYW5pdGl6ZWRFcnJvciIsIlJlc3RRdWVyeSIsIm1ldGhvZCIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsInJ1bkFmdGVyRmluZCIsInJ1bkJlZm9yZUZpbmQiLCJjb250ZXh0IiwiTWV0aG9kIiwiZmluZCIsImdldCIsImluY2x1ZGVzIiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwiaXNHZXQiLCJyZXN1bHQiLCJtYXliZVJ1blF1ZXJ5VHJpZ2dlciIsIlR5cGVzIiwiYmVmb3JlRmluZCIsIlByb21pc2UiLCJyZXNvbHZlIiwiX1Vuc2FmZVJlc3RRdWVyeSIsIk9iamVjdCIsImZyZWV6ZSIsInJlc3BvbnNlIiwiZmluZE9wdGlvbnMiLCJpc01hc3RlciIsInVzZXIiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCIkYW5kIiwiX190eXBlIiwib2JqZWN0SWQiLCJpZCIsImRvQ291bnQiLCJpbmNsdWRlQWxsIiwiaW5jbHVkZSIsImtleXNGb3JJbmNsdWRlIiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwia2V5cyIsImV4Y2x1ZGVLZXlzIiwibGVuZ3RoIiwic3BsaXQiLCJmaWx0ZXIiLCJrZXkiLCJtYXAiLCJzbGljZSIsImxhc3RJbmRleE9mIiwiam9pbiIsIm9wdGlvbiIsImNvbmNhdCIsIkFycmF5IiwiZnJvbSIsIlNldCIsImV4Y2x1ZGUiLCJrIiwiaW5kZXhPZiIsImZpZWxkcyIsIm9yZGVyIiwic29ydCIsInJlZHVjZSIsInNvcnRNYXAiLCJmaWVsZCIsInRyaW0iLCJzY29yZSIsIiRtZXRhIiwicGF0aHMiLCJwYXRoU2V0IiwibWVtbyIsInBhdGgiLCJpbmRleCIsInBhcnRzIiwicyIsImEiLCJiIiwicmVkaXJlY3RLZXkiLCJyZWRpcmVjdENsYXNzTmFtZUZvcktleSIsInJlZGlyZWN0Q2xhc3NOYW1lIiwiSU5WQUxJRF9KU09OIiwiZXhlY3V0ZSIsImV4ZWN1dGVPcHRpb25zIiwidGhlbiIsInZhbGlkYXRlUXVlcnlEZXB0aCIsImJ1aWxkUmVzdFdoZXJlIiwiZGVueVByb3RlY3RlZEZpZWxkcyIsImhhbmRsZUluY2x1ZGVBbGwiLCJ2YWxpZGF0ZUluY2x1ZGVDb21wbGV4aXR5IiwiaGFuZGxlRXhjbHVkZUtleXMiLCJydW5GaW5kIiwicnVuQ291bnQiLCJoYW5kbGVJbmNsdWRlIiwicnVuQWZ0ZXJGaW5kVHJpZ2dlciIsImhhbmRsZUF1dGhBZGFwdGVycyIsImVhY2giLCJjYWxsYmFjayIsImxpbWl0IiwiZmluaXNoZWQiLCJxdWVyeSIsInJlc3VsdHMiLCJmb3JFYWNoIiwiYXNzaWduIiwiJGd0IiwiaXNNYWludGVuYW5jZSIsInJjIiwicmVxdWVzdENvbXBsZXhpdHkiLCJxdWVyeURlcHRoIiwibWF4RGVwdGgiLCJjaGVja0RlcHRoIiwibm9kZSIsImRlcHRoIiwiaXNBcnJheSIsIml0ZW0iLCJpc0xvZ2ljYWwiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImNoZWNrU3VicXVlcnlEZXB0aCIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJhY2wiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImRhdGFiYXNlIiwibmV3Q2xhc3NOYW1lIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJPUEVSQVRJT05fRk9SQklEREVOIiwidHJhbnNmb3JtSW5RdWVyeSIsImluUXVlcnlPYmplY3QiLCJ2YWx1ZXMiLCJwdXNoIiwic3VicXVlcnlEZXB0aCIsIl9zdWJxdWVyeURlcHRoIiwibWVzc2FnZSIsIndhcm4iLCJmaW5kT2JqZWN0V2l0aEtleSIsImluUXVlcnlWYWx1ZSIsIndoZXJlIiwiYWRkaXRpb25hbE9wdGlvbnMiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwicmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeUxpbWl0IiwiY2hpbGRDb250ZXh0Iiwic3VicXVlcnkiLCJ0cmFuc2Zvcm1Ob3RJblF1ZXJ5Iiwibm90SW5RdWVyeU9iamVjdCIsIm5vdEluUXVlcnlWYWx1ZSIsImdldERlZXBlc3RPYmplY3RGcm9tS2V5IiwianNvbiIsImlkeCIsInNyYyIsInNwbGljZSIsInRyYW5zZm9ybVNlbGVjdCIsInNlbGVjdE9iamVjdCIsIm9iamVjdHMiLCJzZWxlY3RWYWx1ZSIsInRyYW5zZm9ybURvbnRTZWxlY3QiLCJkb250U2VsZWN0T2JqZWN0IiwiZG9udFNlbGVjdFZhbHVlIiwiY2xlYW5SZXN1bHRBdXRoRGF0YSIsInBhc3N3b3JkIiwiYXV0aERhdGEiLCJwcm92aWRlciIsInJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQiLCJjb25zdHJhaW50IiwiZXF1YWxUb09iamVjdCIsImhhc0RpcmVjdENvbnN0cmFpbnQiLCJoYXNPcGVyYXRvckNvbnN0cmFpbnQiLCJvcHRpb25zIiwicHJvdmlkZXJzIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0UHJvdmlkZXJzIiwib3AiLCJleHBsYWluIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsInIiLCJjb3VudCIsInNraXAiLCJjIiwicHJvdGVjdGVkRmllbGRzIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwiY2hlY2tXaGVyZSIsIndoZXJlS2V5Iiwicm9vdEZpZWxkIiwidW5kZWZpbmVkIiwic3ViUXVlcnkiLCJzb3J0S2V5IiwiZ2V0T25lU2NoZW1hIiwic2NoZW1hIiwiaW5jbHVkZUZpZWxkcyIsImtleUZpZWxkcyIsInR5cGUiLCJpbmNsdWRlRGVwdGgiLCJNYXRoIiwibWF4IiwiaW5jbHVkZUNvdW50IiwiaW5kZXhlZFJlc3VsdHMiLCJpbmRleGVkIiwiaSIsImV4ZWN1dGlvblRyZWUiLCJjdXJyZW50IiwiY2hpbGRyZW4iLCJyZWN1cnNpdmVFeGVjdXRpb25UcmVlIiwidHJlZU5vZGUiLCJwYXRoUmVzcG9uc2UiLCJpbmNsdWRlUGF0aCIsIm5ld1Jlc3BvbnNlIiwibmV3T2JqZWN0IiwiYWxsIiwiaGFzQWZ0ZXJGaW5kSG9vayIsInRyaWdnZXJFeGlzdHMiLCJhZnRlckZpbmQiLCJhcHBsaWNhdGlvbklkIiwicGlwZWxpbmUiLCJkaXN0aW5jdCIsInBhcnNlUXVlcnkiLCJRdWVyeSIsIndpdGhKU09OIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwib2JqZWN0IiwidG9KU09OIiwicG9pbnRlcnMiLCJmaW5kUG9pbnRlcnMiLCJwb2ludGVyc0hhc2giLCJwb2ludGVyIiwiYWRkIiwiaW5jbHVkZVJlc3RPcHRpb25zIiwia2V5U2V0Iiwic2V0Iiwia2V5UGF0aCIsInNpemUiLCJleGNsdWRlS2V5U2V0IiwiaW5jbHVkZVJlYWRQcmVmZXJlbmNlIiwicXVlcnlQcm9taXNlcyIsIm9iamVjdElkcyIsIiRpbiIsInJlc3BvbnNlcyIsInJlcGxhY2UiLCJpbmNsdWRlUmVzcG9uc2UiLCJvYmoiLCJzZXNzaW9uVG9rZW4iLCJyZXNwIiwicmVwbGFjZVBvaW50ZXJzIiwieCIsImZsYXQiLCJzdWJvYmplY3QiLCJuZXdzdWIiLCJhbnN3ZXIiLCJyb290Iiwic3Via2V5IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQW4gb2JqZWN0IHRoYXQgZW5jYXBzdWxhdGVzIGV2ZXJ5dGhpbmcgd2UgbmVlZCB0byBydW4gYSAnZmluZCdcbi8vIG9wZXJhdGlvbiwgZW5jb2RlZCBpbiB0aGUgUkVTVCBBUEkgZm9ybWF0LlxuXG52YXIgU2NoZW1hQ29udHJvbGxlciA9IHJlcXVpcmUoJy4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcicpO1xudmFyIFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpLlBhcnNlO1xudmFyIGxvZ2dlciA9IHJlcXVpcmUoJy4vbG9nZ2VyJykuZGVmYXVsdDtcbmNvbnN0IHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xuY29uc3QgeyBjb250aW51ZVdoaWxlIH0gPSByZXF1aXJlKCdwYXJzZS9saWIvbm9kZS9wcm9taXNlVXRpbHMnKTtcbmNvbnN0IEFsd2F5c1NlbGVjdGVkS2V5cyA9IFsnb2JqZWN0SWQnLCAnY3JlYXRlZEF0JywgJ3VwZGF0ZWRBdCcsICdBQ0wnXTtcbmNvbnN0IHsgZW5mb3JjZVJvbGVTZWN1cml0eSB9ID0gcmVxdWlyZSgnLi9TaGFyZWRSZXN0Jyk7XG5jb25zdCB7IGNyZWF0ZVNhbml0aXplZEVycm9yIH0gPSByZXF1aXJlKCcuL0Vycm9yJyk7XG5cbi8vIHJlc3RPcHRpb25zIGNhbiBpbmNsdWRlOlxuLy8gICBza2lwXG4vLyAgIGxpbWl0XG4vLyAgIG9yZGVyXG4vLyAgIGNvdW50XG4vLyAgIGluY2x1ZGVcbi8vICAga2V5c1xuLy8gICBleGNsdWRlS2V5c1xuLy8gICByZWRpcmVjdENsYXNzTmFtZUZvcktleVxuLy8gICByZWFkUHJlZmVyZW5jZVxuLy8gICBpbmNsdWRlUmVhZFByZWZlcmVuY2Vcbi8vICAgc3VicXVlcnlSZWFkUHJlZmVyZW5jZVxuLyoqXG4gKiBVc2UgdG8gcGVyZm9ybSBhIHF1ZXJ5IG9uIGEgY2xhc3MuIEl0IHdpbGwgcnVuIHNlY3VyaXR5IGNoZWNrcyBhbmQgdHJpZ2dlcnMuXG4gKiBAcGFyYW0gb3B0aW9uc1xuICogQHBhcmFtIG9wdGlvbnMubWV0aG9kIHtSZXN0UXVlcnkuTWV0aG9kfSBUaGUgdHlwZSBvZiBxdWVyeSB0byBwZXJmb3JtXG4gKiBAcGFyYW0gb3B0aW9ucy5jb25maWcge1BhcnNlU2VydmVyQ29uZmlndXJhdGlvbn0gVGhlIHNlcnZlciBjb25maWd1cmF0aW9uXG4gKiBAcGFyYW0gb3B0aW9ucy5hdXRoIHtBdXRofSBUaGUgYXV0aCBvYmplY3QgZm9yIHRoZSByZXF1ZXN0XG4gKiBAcGFyYW0gb3B0aW9ucy5jbGFzc05hbWUge3N0cmluZ30gVGhlIG5hbWUgb2YgdGhlIGNsYXNzIHRvIHF1ZXJ5XG4gKiBAcGFyYW0gb3B0aW9ucy5yZXN0V2hlcmUge29iamVjdH0gVGhlIHdoZXJlIG9iamVjdCBmb3IgdGhlIHF1ZXJ5XG4gKiBAcGFyYW0gb3B0aW9ucy5yZXN0T3B0aW9ucyB7b2JqZWN0fSBUaGUgb3B0aW9ucyBvYmplY3QgZm9yIHRoZSBxdWVyeVxuICogQHBhcmFtIG9wdGlvbnMucnVuQWZ0ZXJGaW5kIHtib29sZWFufSBXaGV0aGVyIHRvIHJ1biB0aGUgYWZ0ZXJGaW5kIHRyaWdnZXJcbiAqIEBwYXJhbSBvcHRpb25zLnJ1bkJlZm9yZUZpbmQge2Jvb2xlYW59IFdoZXRoZXIgdG8gcnVuIHRoZSBiZWZvcmVGaW5kIHRyaWdnZXJcbiAqIEBwYXJhbSBvcHRpb25zLmNvbnRleHQge29iamVjdH0gVGhlIGNvbnRleHQgb2JqZWN0IGZvciB0aGUgcXVlcnlcbiAqIEByZXR1cm5zIHtQcm9taXNlPF9VbnNhZmVSZXN0UXVlcnk+fSBBIHByb21pc2UgdGhhdCBpcyByZXNvbHZlZCB3aXRoIHRoZSBfVW5zYWZlUmVzdFF1ZXJ5IG9iamVjdFxuICovXG5hc3luYyBmdW5jdGlvbiBSZXN0UXVlcnkoe1xuICBtZXRob2QsXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUgPSB7fSxcbiAgcmVzdE9wdGlvbnMgPSB7fSxcbiAgcnVuQWZ0ZXJGaW5kID0gdHJ1ZSxcbiAgcnVuQmVmb3JlRmluZCA9IHRydWUsXG4gIGNvbnRleHQsXG59KSB7XG4gIGlmICghW1Jlc3RRdWVyeS5NZXRob2QuZmluZCwgUmVzdFF1ZXJ5Lk1ldGhvZC5nZXRdLmluY2x1ZGVzKG1ldGhvZCkpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ2JhZCBxdWVyeSB0eXBlJyk7XG4gIH1cbiAgY29uc3QgaXNHZXQgPSBtZXRob2QgPT09IFJlc3RRdWVyeS5NZXRob2QuZ2V0O1xuICBlbmZvcmNlUm9sZVNlY3VyaXR5KG1ldGhvZCwgY2xhc3NOYW1lLCBhdXRoLCBjb25maWcpO1xuICBjb25zdCByZXN1bHQgPSBydW5CZWZvcmVGaW5kXG4gICAgPyBhd2FpdCB0cmlnZ2Vycy5tYXliZVJ1blF1ZXJ5VHJpZ2dlcihcbiAgICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUZpbmQsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICByZXN0V2hlcmUsXG4gICAgICByZXN0T3B0aW9ucyxcbiAgICAgIGNvbmZpZyxcbiAgICAgIGF1dGgsXG4gICAgICBjb250ZXh0LFxuICAgICAgaXNHZXRcbiAgICApXG4gICAgOiBQcm9taXNlLnJlc29sdmUoeyByZXN0V2hlcmUsIHJlc3RPcHRpb25zIH0pO1xuXG4gIHJldHVybiBuZXcgX1Vuc2FmZVJlc3RRdWVyeShcbiAgICBjb25maWcsXG4gICAgYXV0aCxcbiAgICBjbGFzc05hbWUsXG4gICAgcmVzdWx0LnJlc3RXaGVyZSB8fCByZXN0V2hlcmUsXG4gICAgcmVzdWx0LnJlc3RPcHRpb25zIHx8IHJlc3RPcHRpb25zLFxuICAgIHJ1bkFmdGVyRmluZCxcbiAgICBjb250ZXh0LFxuICAgIGlzR2V0XG4gICk7XG59XG5cblJlc3RRdWVyeS5NZXRob2QgPSBPYmplY3QuZnJlZXplKHtcbiAgZ2V0OiAnZ2V0JyxcbiAgZmluZDogJ2ZpbmQnLFxufSk7XG5cbi8qKlxuICogX1Vuc2FmZVJlc3RRdWVyeSBpcyBtZWFudCBmb3Igc3BlY2lmaWMgaW50ZXJuYWwgdXNhZ2Ugb25seS4gV2hlbiB5b3UgbmVlZCB0byBza2lwIHNlY3VyaXR5IGNoZWNrcyBvciBzb21lIHRyaWdnZXJzLlxuICogRG9uJ3QgdXNlIGl0IGlmIHlvdSBkb24ndCBrbm93IHdoYXQgeW91IGFyZSBkb2luZy5cbiAqIEBwYXJhbSBjb25maWdcbiAqIEBwYXJhbSBhdXRoXG4gKiBAcGFyYW0gY2xhc3NOYW1lXG4gKiBAcGFyYW0gcmVzdFdoZXJlXG4gKiBAcGFyYW0gcmVzdE9wdGlvbnNcbiAqIEBwYXJhbSBydW5BZnRlckZpbmRcbiAqIEBwYXJhbSBjb250ZXh0XG4gKi9cbmZ1bmN0aW9uIF9VbnNhZmVSZXN0UXVlcnkoXG4gIGNvbmZpZyxcbiAgYXV0aCxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUgPSB7fSxcbiAgcmVzdE9wdGlvbnMgPSB7fSxcbiAgcnVuQWZ0ZXJGaW5kID0gdHJ1ZSxcbiAgY29udGV4dCxcbiAgaXNHZXRcbikge1xuICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgdGhpcy5hdXRoID0gYXV0aDtcbiAgdGhpcy5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHRoaXMucmVzdFdoZXJlID0gcmVzdFdoZXJlO1xuICB0aGlzLnJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnM7XG4gIHRoaXMucnVuQWZ0ZXJGaW5kID0gcnVuQWZ0ZXJGaW5kO1xuICB0aGlzLnJlc3BvbnNlID0gbnVsbDtcbiAgdGhpcy5maW5kT3B0aW9ucyA9IHt9O1xuICB0aGlzLmNvbnRleHQgPSBjb250ZXh0IHx8IHt9O1xuICB0aGlzLmlzR2V0ID0gaXNHZXQ7XG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgaWYgKHRoaXMuY2xhc3NOYW1lID09ICdfU2Vzc2lvbicpIHtcbiAgICAgIGlmICghdGhpcy5hdXRoLnVzZXIpIHtcbiAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLCAnSW52YWxpZCBzZXNzaW9uIHRva2VuJywgY29uZmlnKTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAkYW5kOiBbXG4gICAgICAgICAgdGhpcy5yZXN0V2hlcmUsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdXNlcjoge1xuICAgICAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICBvYmplY3RJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuZG9Db3VudCA9IGZhbHNlO1xuICB0aGlzLmluY2x1ZGVBbGwgPSBmYWxzZTtcblxuICAvLyBUaGUgZm9ybWF0IGZvciB0aGlzLmluY2x1ZGUgaXMgbm90IHRoZSBzYW1lIGFzIHRoZSBmb3JtYXQgZm9yIHRoZVxuICAvLyBpbmNsdWRlIG9wdGlvbiAtIGl0J3MgdGhlIHBhdGhzIHdlIHNob3VsZCBpbmNsdWRlLCBpbiBvcmRlcixcbiAgLy8gc3RvcmVkIGFzIGFycmF5cywgdGFraW5nIGludG8gYWNjb3VudCB0aGF0IHdlIG5lZWQgdG8gaW5jbHVkZSBmb29cbiAgLy8gYmVmb3JlIGluY2x1ZGluZyBmb28uYmFyLiBBbHNvIGl0IHNob3VsZCBkZWR1cGUuXG4gIC8vIEZvciBleGFtcGxlLCBwYXNzaW5nIGFuIGFyZyBvZiBpbmNsdWRlPWZvby5iYXIsZm9vLmJheiBjb3VsZCBsZWFkIHRvXG4gIC8vIHRoaXMuaW5jbHVkZSA9IFtbJ2ZvbyddLCBbJ2ZvbycsICdiYXonXSwgWydmb28nLCAnYmFyJ11dXG4gIHRoaXMuaW5jbHVkZSA9IFtdO1xuICBsZXQga2V5c0ZvckluY2x1ZGUgPSAnJztcblxuICAvLyBJZiB3ZSBoYXZlIGtleXMsIHdlIHByb2JhYmx5IHdhbnQgdG8gZm9yY2Ugc29tZSBpbmNsdWRlcyAobi0xIGxldmVsKVxuICAvLyBTZWUgaXNzdWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy8zMTg1XG4gIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdE9wdGlvbnMsICdrZXlzJykpIHtcbiAgICBrZXlzRm9ySW5jbHVkZSA9IHJlc3RPcHRpb25zLmtleXM7XG4gIH1cblxuICAvLyBJZiB3ZSBoYXZlIGtleXMsIHdlIHByb2JhYmx5IHdhbnQgdG8gZm9yY2Ugc29tZSBpbmNsdWRlcyAobi0xIGxldmVsKVxuICAvLyBpbiBvcmRlciB0byBleGNsdWRlIHNwZWNpZmljIGtleXMuXG4gIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdE9wdGlvbnMsICdleGNsdWRlS2V5cycpKSB7XG4gICAga2V5c0ZvckluY2x1ZGUgKz0gJywnICsgcmVzdE9wdGlvbnMuZXhjbHVkZUtleXM7XG4gIH1cblxuICBpZiAoa2V5c0ZvckluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIGtleXNGb3JJbmNsdWRlID0ga2V5c0ZvckluY2x1ZGVcbiAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAuZmlsdGVyKGtleSA9PiB7XG4gICAgICAgIC8vIEF0IGxlYXN0IDIgY29tcG9uZW50c1xuICAgICAgICByZXR1cm4ga2V5LnNwbGl0KCcuJykubGVuZ3RoID4gMTtcbiAgICAgIH0pXG4gICAgICAubWFwKGtleSA9PiB7XG4gICAgICAgIC8vIFNsaWNlIHRoZSBsYXN0IGNvbXBvbmVudCAoYS5iLmMgLT4gYS5iKVxuICAgICAgICAvLyBPdGhlcndpc2Ugd2UnbGwgaW5jbHVkZSBvbmUgbGV2ZWwgdG9vIG11Y2guXG4gICAgICAgIHJldHVybiBrZXkuc2xpY2UoMCwga2V5Lmxhc3RJbmRleE9mKCcuJykpO1xuICAgICAgfSlcbiAgICAgIC5qb2luKCcsJyk7XG5cbiAgICAvLyBDb25jYXQgdGhlIHBvc3NpYmx5IHByZXNlbnQgaW5jbHVkZSBzdHJpbmcgd2l0aCB0aGUgb25lIGZyb20gdGhlIGtleXNcbiAgICAvLyBEZWR1cCAvIHNvcnRpbmcgaXMgaGFuZGxlIGluICdpbmNsdWRlJyBjYXNlLlxuICAgIGlmIChrZXlzRm9ySW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgICBpZiAoIXJlc3RPcHRpb25zLmluY2x1ZGUgfHwgcmVzdE9wdGlvbnMuaW5jbHVkZS5sZW5ndGggPT0gMCkge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlID0ga2V5c0ZvckluY2x1ZGU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXN0T3B0aW9ucy5pbmNsdWRlICs9ICcsJyArIGtleXNGb3JJbmNsdWRlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZvciAodmFyIG9wdGlvbiBpbiByZXN0T3B0aW9ucykge1xuICAgIHN3aXRjaCAob3B0aW9uKSB7XG4gICAgICBjYXNlICdrZXlzJzoge1xuICAgICAgICBjb25zdCBrZXlzID0gcmVzdE9wdGlvbnMua2V5c1xuICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgLmZpbHRlcihrZXkgPT4ga2V5Lmxlbmd0aCA+IDApXG4gICAgICAgICAgLmNvbmNhdChBbHdheXNTZWxlY3RlZEtleXMpO1xuICAgICAgICB0aGlzLmtleXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoa2V5cykpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ2V4Y2x1ZGVLZXlzJzoge1xuICAgICAgICBjb25zdCBleGNsdWRlID0gcmVzdE9wdGlvbnMuZXhjbHVkZUtleXNcbiAgICAgICAgICAuc3BsaXQoJywnKVxuICAgICAgICAgIC5maWx0ZXIoayA9PiBBbHdheXNTZWxlY3RlZEtleXMuaW5kZXhPZihrKSA8IDApO1xuICAgICAgICB0aGlzLmV4Y2x1ZGVLZXlzID0gQXJyYXkuZnJvbShuZXcgU2V0KGV4Y2x1ZGUpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdjb3VudCc6XG4gICAgICAgIHRoaXMuZG9Db3VudCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZUFsbCc6XG4gICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZXhwbGFpbic6XG4gICAgICBjYXNlICdoaW50JzpcbiAgICAgIGNhc2UgJ2Rpc3RpbmN0JzpcbiAgICAgIGNhc2UgJ3BpcGVsaW5lJzpcbiAgICAgIGNhc2UgJ3NraXAnOlxuICAgICAgY2FzZSAnbGltaXQnOlxuICAgICAgY2FzZSAncmVhZFByZWZlcmVuY2UnOlxuICAgICAgY2FzZSAnY29tbWVudCc6XG4gICAgICBjYXNlICdyYXdWYWx1ZXMnOlxuICAgICAgY2FzZSAncmF3RmllbGROYW1lcyc6XG4gICAgICAgIHRoaXMuZmluZE9wdGlvbnNbb3B0aW9uXSA9IHJlc3RPcHRpb25zW29wdGlvbl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnb3JkZXInOlxuICAgICAgICB2YXIgZmllbGRzID0gcmVzdE9wdGlvbnMub3JkZXIuc3BsaXQoJywnKTtcbiAgICAgICAgdGhpcy5maW5kT3B0aW9ucy5zb3J0ID0gZmllbGRzLnJlZHVjZSgoc29ydE1hcCwgZmllbGQpID0+IHtcbiAgICAgICAgICBmaWVsZCA9IGZpZWxkLnRyaW0oKTtcbiAgICAgICAgICBpZiAoZmllbGQgPT09ICckc2NvcmUnIHx8IGZpZWxkID09PSAnLSRzY29yZScpIHtcbiAgICAgICAgICAgIHNvcnRNYXAuc2NvcmUgPSB7ICRtZXRhOiAndGV4dFNjb3JlJyB9O1xuICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRbMF0gPT0gJy0nKSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkLnNsaWNlKDEpXSA9IC0xO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzb3J0TWFwW2ZpZWxkXSA9IDE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzb3J0TWFwO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZSc6IHtcbiAgICAgICAgY29uc3QgcGF0aHMgPSByZXN0T3B0aW9ucy5pbmNsdWRlLnNwbGl0KCcsJyk7XG4gICAgICAgIGlmIChwYXRocy5pbmNsdWRlcygnKicpKSB7XG4gICAgICAgICAgdGhpcy5pbmNsdWRlQWxsID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICAvLyBMb2FkIHRoZSBleGlzdGluZyBpbmNsdWRlcyAoZnJvbSBrZXlzKVxuICAgICAgICBjb25zdCBwYXRoU2V0ID0gcGF0aHMucmVkdWNlKChtZW1vLCBwYXRoKSA9PiB7XG4gICAgICAgICAgLy8gU3BsaXQgZWFjaCBwYXRocyBvbiAuIChhLmIuYyAtPiBbYSxiLGNdKVxuICAgICAgICAgIC8vIHJlZHVjZSB0byBjcmVhdGUgYWxsIHBhdGhzXG4gICAgICAgICAgLy8gKFthLGIsY10gLT4ge2E6IHRydWUsICdhLmInOiB0cnVlLCAnYS5iLmMnOiB0cnVlfSlcbiAgICAgICAgICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnJlZHVjZSgobWVtbywgcGF0aCwgaW5kZXgsIHBhcnRzKSA9PiB7XG4gICAgICAgICAgICBtZW1vW3BhcnRzLnNsaWNlKDAsIGluZGV4ICsgMSkuam9pbignLicpXSA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgICB9LCBtZW1vKTtcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIHRoaXMuaW5jbHVkZSA9IE9iamVjdC5rZXlzKHBhdGhTZXQpXG4gICAgICAgICAgLm1hcChzID0+IHtcbiAgICAgICAgICAgIHJldHVybiBzLnNwbGl0KCcuJyk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7IC8vIFNvcnQgYnkgbnVtYmVyIG9mIGNvbXBvbmVudHNcbiAgICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdyZWRpcmVjdENsYXNzTmFtZUZvcktleSc6XG4gICAgICAgIHRoaXMucmVkaXJlY3RLZXkgPSByZXN0T3B0aW9ucy5yZWRpcmVjdENsYXNzTmFtZUZvcktleTtcbiAgICAgICAgdGhpcy5yZWRpcmVjdENsYXNzTmFtZSA9IG51bGw7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgIGNhc2UgJ3N1YnF1ZXJ5UmVhZFByZWZlcmVuY2UnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgb3B0aW9uOiAnICsgb3B0aW9uKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gQSBjb252ZW5pZW50IG1ldGhvZCB0byBwZXJmb3JtIGFsbCB0aGUgc3RlcHMgb2YgcHJvY2Vzc2luZyBhIHF1ZXJ5XG4vLyBpbiBvcmRlci5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgcmVzcG9uc2UgLSBhbiBvYmplY3Qgd2l0aCBvcHRpb25hbCBrZXlzXG4vLyAncmVzdWx0cycgYW5kICdjb3VudCcuXG4vLyBUT0RPOiBjb25zb2xpZGF0ZSB0aGUgcmVwbGFjZVggZnVuY3Rpb25zXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24gKGV4ZWN1dGVPcHRpb25zKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlUXVlcnlEZXB0aCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuYnVpbGRSZXN0V2hlcmUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbnlQcm90ZWN0ZWRGaWVsZHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnZhbGlkYXRlSW5jbHVkZUNvbXBsZXhpdHkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUV4Y2x1ZGVLZXlzKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5GaW5kKGV4ZWN1dGVPcHRpb25zKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkNvdW50KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVJbmNsdWRlKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5ydW5BZnRlckZpbmRUcmlnZ2VyKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVBdXRoQWRhcHRlcnMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlc3BvbnNlO1xuICAgIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuZWFjaCA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICBjb25zdCB7IGNvbmZpZywgYXV0aCwgY2xhc3NOYW1lLCByZXN0V2hlcmUsIHJlc3RPcHRpb25zIH0gPSB0aGlzO1xuICAvLyBpZiB0aGUgbGltaXQgaXMgc2V0LCB1c2UgaXRcbiAgcmVzdE9wdGlvbnMubGltaXQgPSByZXN0T3B0aW9ucy5saW1pdCB8fCAxMDA7XG4gIHJlc3RPcHRpb25zLm9yZGVyID0gJ29iamVjdElkJztcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGNvbnRpbnVlV2hpbGUoXG4gICAgKCkgPT4ge1xuICAgICAgcmV0dXJuICFmaW5pc2hlZDtcbiAgICB9LFxuICAgIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFNhZmUgaGVyZSB0byB1c2UgX1Vuc2FmZVJlc3RRdWVyeSBiZWNhdXNlIHRoZSBzZWN1cml0eSB3YXMgYWxyZWFkeVxuICAgICAgLy8gY2hlY2tlZCBkdXJpbmcgXCJhd2FpdCBSZXN0UXVlcnkoKVwiXG4gICAgICBjb25zdCBxdWVyeSA9IG5ldyBfVW5zYWZlUmVzdFF1ZXJ5KFxuICAgICAgICBjb25maWcsXG4gICAgICAgIGF1dGgsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVzdFdoZXJlLFxuICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgdGhpcy5ydW5BZnRlckZpbmQsXG4gICAgICAgIHRoaXMuY29udGV4dFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgcmVzdWx0cyB9ID0gYXdhaXQgcXVlcnkuZXhlY3V0ZSgpO1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKGNhbGxiYWNrKTtcbiAgICAgIGZpbmlzaGVkID0gcmVzdWx0cy5sZW5ndGggPCByZXN0T3B0aW9ucy5saW1pdDtcbiAgICAgIGlmICghZmluaXNoZWQpIHtcbiAgICAgICAgcmVzdFdoZXJlLm9iamVjdElkID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdFdoZXJlLm9iamVjdElkLCB7XG4gICAgICAgICAgJGd0OiByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0ub2JqZWN0SWQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgKTtcbn07XG5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnZhbGlkYXRlUXVlcnlEZXB0aCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICBpZiAoIXJjIHx8IHJjLnF1ZXJ5RGVwdGggPT09IC0xKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IG1heERlcHRoID0gcmMucXVlcnlEZXB0aDtcbiAgY29uc3QgY2hlY2tEZXB0aCA9IChub2RlLCBkZXB0aCkgPT4ge1xuICAgIGlmIChkZXB0aCA+IG1heERlcHRoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgIGBRdWVyeSBjb25kaXRpb24gbmVzdGluZyBkZXB0aCBleGNlZWRzIG1heGltdW0gYWxsb3dlZCBkZXB0aCBvZiAke21heERlcHRofWBcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChub2RlID09PSBudWxsIHx8IHR5cGVvZiBub2RlICE9PSAnb2JqZWN0Jykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheShub2RlKSkge1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIG5vZGUpIHtcbiAgICAgICAgY2hlY2tEZXB0aChpdGVtLCBkZXB0aCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIERlc2NlbmQgaW50byBldmVyeSB2YWx1ZSBzbyB0aGF0IGxvZ2ljYWwgb3BlcmF0b3JzICgkb3IvJGFuZC8kbm9yKSBuZXN0ZWRcbiAgICAvLyB1bmRlciBmaWVsZC1sZXZlbCBvcGVyYXRvcnMgKGUuZy4gJGVsZW1NYXRjaCwgJG5vdCkgb3IgcGxhaW4gZmllbGQgbmFtZXMgYXJlXG4gICAgLy8gc3RpbGwgY291bnRlZC4gT25seSBsb2dpY2FsIG9wZXJhdG9ycyBpbmNyZWFzZSB0aGUgZGVwdGgsIHdoaWNoIHByZXNlcnZlcyB0aGVcbiAgICAvLyBkb2N1bWVudGVkIG1lYW5pbmcgb2YgYHF1ZXJ5RGVwdGhgLlxuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKG5vZGUpKSB7XG4gICAgICBjb25zdCBpc0xvZ2ljYWwgPSBrZXkgPT09ICckb3InIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRub3InO1xuICAgICAgY2hlY2tEZXB0aChub2RlW2tleV0sIGlzTG9naWNhbCA/IGRlcHRoICsgMSA6IGRlcHRoKTtcbiAgICB9XG4gIH07XG4gIGNoZWNrRGVwdGgodGhpcy5yZXN0V2hlcmUsIDApO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuYnVpbGRSZXN0V2hlcmUgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZWRpcmVjdENsYXNzTmFtZUZvcktleSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jaGVja1N1YnF1ZXJ5RGVwdGgoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VTZWxlY3QoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VEb250U2VsZWN0KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlSW5RdWVyeSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZU5vdEluUXVlcnkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VFcXVhbGl0eSgpO1xuICAgIH0pO1xufTtcblxuLy8gVXNlcyB0aGUgQXV0aCBvYmplY3QgdG8gZ2V0IHRoZSBsaXN0IG9mIHJvbGVzLCBhZGRzIHRoZSB1c2VyIGlkXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIHRoaXMuZmluZE9wdGlvbnMuYWNsID0gWycqJ107XG5cbiAgaWYgKHRoaXMuYXV0aC51c2VyKSB7XG4gICAgcmV0dXJuIHRoaXMuYXV0aC5nZXRVc2VyUm9sZXMoKS50aGVuKHJvbGVzID0+IHtcbiAgICAgIHRoaXMuZmluZE9wdGlvbnMuYWNsID0gdGhpcy5maW5kT3B0aW9ucy5hY2wuY29uY2F0KHJvbGVzLCBbdGhpcy5hdXRoLnVzZXIuaWRdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIENoYW5nZXMgdGhlIGNsYXNzTmFtZSBpZiByZWRpcmVjdENsYXNzTmFtZUZvcktleSBpcyBzZXQuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZS5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5ID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMucmVkaXJlY3RLZXkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXZSBuZWVkIHRvIGNoYW5nZSB0aGUgY2xhc3MgbmFtZSBiYXNlZCBvbiB0aGUgc2NoZW1hXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5yZWRpcmVjdENsYXNzTmFtZUZvcktleSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZWRpcmVjdEtleSlcbiAgICAudGhlbihuZXdDbGFzc05hbWUgPT4ge1xuICAgICAgdGhpcy5jbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgICB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lID0gbmV3Q2xhc3NOYW1lO1xuXG4gICAgICAvLyBSZS1hcHBseSBzZWN1cml0eSBjaGVja3MgZm9yIHRoZSByZWRpcmVjdGVkIGNsYXNzIG5hbWUsIHNpbmNlIHRoZVxuICAgICAgLy8gY2hlY2tzIGluIHRoZSBjb25zdHJ1Y3RvciBhbmQgaW4gcmVzdC5maW5kIHJhbiBhZ2FpbnN0IHRoZSBvcmlnaW5hbFxuICAgICAgLy8gY2xhc3MgbmFtZSBiZWZvcmUgdGhlIHJlZGlyZWN0LlxuICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgZW5mb3JjZVJvbGVTZWN1cml0eSgnZmluZCcsIHRoaXMuY2xhc3NOYW1lLCB0aGlzLmF1dGgsIHRoaXMuY29uZmlnKTtcblxuICAgICAgICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfU2Vzc2lvbicpIHtcbiAgICAgICAgICBpZiAoIXRoaXMuYXV0aC51c2VyKSB7XG4gICAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgICAgICAgICAnSW52YWxpZCBzZXNzaW9uIHRva2VuJyxcbiAgICAgICAgICAgICAgdGhpcy5jb25maWdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMucmVzdFdoZXJlID0ge1xuICAgICAgICAgICAgJGFuZDogW1xuICAgICAgICAgICAgICB0aGlzLnJlc3RXaGVyZSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHVzZXI6IHtcbiAgICAgICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICAgICAgICAgICAgb2JqZWN0SWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBdLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUudmFsaWRhdGVDbGllbnRDbGFzc0NyZWF0aW9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgJ1RoaXMgdXNlciBpcyBub3QgYWxsb3dlZCB0byBhY2Nlc3MgJyArICdub24tZXhpc3RlbnQgY2xhc3M6ICcgKyB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1JblF1ZXJ5KGluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgZGVsZXRlIGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmIChBcnJheS5pc0FycmF5KGluUXVlcnlPYmplY3RbJyRpbiddKSkge1xuICAgIGluUXVlcnlPYmplY3RbJyRpbiddID0gaW5RdWVyeU9iamVjdFsnJGluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSB2YWx1ZXM7XG4gIH1cbn1cblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuY2hlY2tTdWJxdWVyeURlcHRoID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyIHx8IHRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHJjID0gdGhpcy5jb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gIGlmICghcmMgfHwgcmMuc3VicXVlcnlEZXB0aCA9PT0gLTEpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgZGVwdGggPSB0aGlzLmNvbnRleHQuX3N1YnF1ZXJ5RGVwdGggfHwgMDtcbiAgaWYgKGRlcHRoID4gcmMuc3VicXVlcnlEZXB0aCkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBgU3VicXVlcnkgbmVzdGluZyBkZXB0aCBleGNlZWRzIG1heGltdW0gYWxsb3dlZCBkZXB0aCBvZiAke3JjLnN1YnF1ZXJ5RGVwdGh9YDtcbiAgICBsb2dnZXIud2FybihtZXNzYWdlKTtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgbWVzc2FnZSk7XG4gIH1cbn07XG5cbi8vIFJlcGxhY2VzIGEgJGluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJGluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRpblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlSW5RdWVyeSA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgdmFyIGluUXVlcnlPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRpblF1ZXJ5Jyk7XG4gIGlmICghaW5RdWVyeU9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBpblF1ZXJ5IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSB3aGVyZSBhbmQgY2xhc3NOYW1lXG4gIHZhciBpblF1ZXJ5VmFsdWUgPSBpblF1ZXJ5T2JqZWN0WyckaW5RdWVyeSddO1xuICBpZiAoIWluUXVlcnlWYWx1ZS53aGVyZSB8fCAhaW5RdWVyeVZhbHVlLmNsYXNzTmFtZSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnaW1wcm9wZXIgdXNhZ2Ugb2YgJGluUXVlcnknKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBpblF1ZXJ5VmFsdWUucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGNvbnN0IHJjID0gdGhpcy5jb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gICAgaWYgKHJjICYmIHJjLnN1YnF1ZXJ5TGltaXQgPiAwKSB7XG4gICAgICBhZGRpdGlvbmFsT3B0aW9ucy5saW1pdCA9IHJjLnN1YnF1ZXJ5TGltaXQ7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY2hpbGRDb250ZXh0ID0geyAuLi50aGlzLmNvbnRleHQsIF9zdWJxdWVyeURlcHRoOiAodGhpcy5jb250ZXh0Ll9zdWJxdWVyeURlcHRoIHx8IDApICsgMSB9O1xuICBjb25zdCBzdWJxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICBhdXRoOiB0aGlzLmF1dGgsXG4gICAgY2xhc3NOYW1lOiBpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lLFxuICAgIHJlc3RXaGVyZTogaW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIHJlc3RPcHRpb25zOiBhZGRpdGlvbmFsT3B0aW9ucyxcbiAgICBjb250ZXh0OiBjaGlsZENvbnRleHQsXG4gIH0pO1xuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgc3VicXVlcnkuY2xhc3NOYW1lLCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBSZWN1cnNlIHRvIHJlcGVhdFxuICAgIHJldHVybiB0aGlzLnJlcGxhY2VJblF1ZXJ5KCk7XG4gIH0pO1xufTtcblxuZnVuY3Rpb24gdHJhbnNmb3JtTm90SW5RdWVyeShub3RJblF1ZXJ5T2JqZWN0LCBjbGFzc05hbWUsIHJlc3VsdHMpIHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2YgcmVzdWx0cykge1xuICAgIHZhbHVlcy5wdXNoKHtcbiAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgY2xhc3NOYW1lOiBjbGFzc05hbWUsXG4gICAgICBvYmplY3RJZDogcmVzdWx0Lm9iamVjdElkLFxuICAgIH0pO1xuICB9XG4gIGRlbGV0ZSBub3RJblF1ZXJ5T2JqZWN0Wyckbm90SW5RdWVyeSddO1xuICBpZiAoQXJyYXkuaXNBcnJheShub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10pKSB7XG4gICAgbm90SW5RdWVyeU9iamVjdFsnJG5pbiddID0gbm90SW5RdWVyeU9iamVjdFsnJG5pbiddLmNvbmNhdCh2YWx1ZXMpO1xuICB9IGVsc2Uge1xuICAgIG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRub3RJblF1ZXJ5IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYW5cbi8vICRub3RJblF1ZXJ5IGNsYXVzZS5cbi8vIFRoZSAkbm90SW5RdWVyeSBjbGF1c2UgdHVybnMgaW50byBhICRuaW4gd2l0aCB2YWx1ZXMgdGhhdCBhcmUganVzdFxuLy8gcG9pbnRlcnMgdG8gdGhlIG9iamVjdHMgcmV0dXJuZWQgaW4gdGhlIHN1YnF1ZXJ5LlxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZU5vdEluUXVlcnkgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIHZhciBub3RJblF1ZXJ5T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckbm90SW5RdWVyeScpO1xuICBpZiAoIW5vdEluUXVlcnlPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgbm90SW5RdWVyeSB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gd2hlcmUgYW5kIGNsYXNzTmFtZVxuICB2YXIgbm90SW5RdWVyeVZhbHVlID0gbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKCFub3RJblF1ZXJ5VmFsdWUud2hlcmUgfHwgIW5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ2ltcHJvcGVyIHVzYWdlIG9mICRub3RJblF1ZXJ5Jyk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogbm90SW5RdWVyeVZhbHVlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBpZiAoIXRoaXMuYXV0aC5pc01hc3RlciAmJiAhdGhpcy5hdXRoLmlzTWFpbnRlbmFuY2UpIHtcbiAgICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICAgIGlmIChyYyAmJiByYy5zdWJxdWVyeUxpbWl0ID4gMCkge1xuICAgICAgYWRkaXRpb25hbE9wdGlvbnMubGltaXQgPSByYy5zdWJxdWVyeUxpbWl0O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNoaWxkQ29udGV4dCA9IHsgLi4udGhpcy5jb250ZXh0LCBfc3VicXVlcnlEZXB0aDogKHRoaXMuY29udGV4dC5fc3VicXVlcnlEZXB0aCB8fCAwKSArIDEgfTtcbiAgY29uc3Qgc3VicXVlcnkgPSBhd2FpdCBSZXN0UXVlcnkoe1xuICAgIG1ldGhvZDogUmVzdFF1ZXJ5Lk1ldGhvZC5maW5kLFxuICAgIGNvbmZpZzogdGhpcy5jb25maWcsXG4gICAgYXV0aDogdGhpcy5hdXRoLFxuICAgIGNsYXNzTmFtZTogbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSxcbiAgICByZXN0V2hlcmU6IG5vdEluUXVlcnlWYWx1ZS53aGVyZSxcbiAgICByZXN0T3B0aW9uczogYWRkaXRpb25hbE9wdGlvbnMsXG4gICAgY29udGV4dDogY2hpbGRDb250ZXh0LFxuICB9KTtcblxuICByZXR1cm4gc3VicXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHRyYW5zZm9ybU5vdEluUXVlcnkobm90SW5RdWVyeU9iamVjdCwgc3VicXVlcnkuY2xhc3NOYW1lLCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBSZWN1cnNlIHRvIHJlcGVhdFxuICAgIHJldHVybiB0aGlzLnJlcGxhY2VOb3RJblF1ZXJ5KCk7XG4gIH0pO1xufTtcblxuLy8gVXNlZCB0byBnZXQgdGhlIGRlZXBlc3Qgb2JqZWN0IGZyb20ganNvbiB1c2luZyBkb3Qgbm90YXRpb24uXG5jb25zdCBnZXREZWVwZXN0T2JqZWN0RnJvbUtleSA9IChqc29uLCBrZXksIGlkeCwgc3JjKSA9PiB7XG4gIGlmIChrZXkgaW4ganNvbikge1xuICAgIHJldHVybiBqc29uW2tleV07XG4gIH1cbiAgc3JjLnNwbGljZSgxKTsgLy8gRXhpdCBFYXJseVxufTtcblxuY29uc3QgdHJhbnNmb3JtU2VsZWN0ID0gKHNlbGVjdE9iamVjdCwga2V5LCBvYmplY3RzKSA9PiB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIG9iamVjdHMpIHtcbiAgICB2YWx1ZXMucHVzaChrZXkuc3BsaXQoJy4nKS5yZWR1Y2UoZ2V0RGVlcGVzdE9iamVjdEZyb21LZXksIHJlc3VsdCkpO1xuICB9XG4gIGRlbGV0ZSBzZWxlY3RPYmplY3RbJyRzZWxlY3QnXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoc2VsZWN0T2JqZWN0WyckaW4nXSkpIHtcbiAgICBzZWxlY3RPYmplY3RbJyRpbiddID0gc2VsZWN0T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxlY3RPYmplY3RbJyRpbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRzZWxlY3QgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhXG4vLyAkc2VsZWN0IGNsYXVzZS5cbi8vIFRoZSAkc2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRpbiB3aXRoIHZhbHVlcyBzZWxlY3RlZCBvdXQgb2Zcbi8vIHRoZSBzdWJxdWVyeS5cbi8vIFJldHVybnMgYSBwb3NzaWJsZS1wcm9taXNlLlxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZVNlbGVjdCA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJHNlbGVjdCcpO1xuICBpZiAoIXNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBzZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIHNlbGVjdFZhbHVlID0gc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIC8vIGlPUyBTREsgZG9uJ3Qgc2VuZCB3aGVyZSBpZiBub3Qgc2V0LCBsZXQgaXQgcGFzc1xuICBpZiAoXG4gICAgIXNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgIXNlbGVjdFZhbHVlLmtleSB8fFxuICAgIHR5cGVvZiBzZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgT2JqZWN0LmtleXMoc2VsZWN0VmFsdWUpLmxlbmd0aCAhPT0gMlxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ2ltcHJvcGVyIHVzYWdlIG9mICRzZWxlY3QnKTtcbiAgfVxuXG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBzZWxlY3RWYWx1ZS5xdWVyeS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfSBlbHNlIGlmICh0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIgJiYgIXRoaXMuYXV0aC5pc01haW50ZW5hbmNlKSB7XG4gICAgY29uc3QgcmMgPSB0aGlzLmNvbmZpZy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgICBpZiAocmMgJiYgcmMuc3VicXVlcnlMaW1pdCA+IDApIHtcbiAgICAgIGFkZGl0aW9uYWxPcHRpb25zLmxpbWl0ID0gcmMuc3VicXVlcnlMaW1pdDtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjaGlsZENvbnRleHQgPSB7IC4uLnRoaXMuY29udGV4dCwgX3N1YnF1ZXJ5RGVwdGg6ICh0aGlzLmNvbnRleHQuX3N1YnF1ZXJ5RGVwdGggfHwgMCkgKyAxIH07XG4gIGNvbnN0IHN1YnF1ZXJ5ID0gYXdhaXQgUmVzdFF1ZXJ5KHtcbiAgICBtZXRob2Q6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICBjb25maWc6IHRoaXMuY29uZmlnLFxuICAgIGF1dGg6IHRoaXMuYXV0aCxcbiAgICBjbGFzc05hbWU6IHNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSxcbiAgICByZXN0V2hlcmU6IHNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIHJlc3RPcHRpb25zOiBhZGRpdGlvbmFsT3B0aW9ucyxcbiAgICBjb250ZXh0OiBjaGlsZENvbnRleHQsXG4gIH0pO1xuXG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtU2VsZWN0KHNlbGVjdE9iamVjdCwgc2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkc2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlU2VsZWN0KCk7XG4gIH0pO1xufTtcblxuY29uc3QgdHJhbnNmb3JtRG9udFNlbGVjdCA9IChkb250U2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZShnZXREZWVwZXN0T2JqZWN0RnJvbUtleSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSBkb250U2VsZWN0T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRkb250U2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJGRvbnRTZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRkb250U2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRuaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VEb250U2VsZWN0ID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICB2YXIgZG9udFNlbGVjdE9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGRvbnRTZWxlY3QnKTtcbiAgaWYgKCFkb250U2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGRvbnRTZWxlY3QgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHF1ZXJ5IGFuZCBrZXlcbiAgdmFyIGRvbnRTZWxlY3RWYWx1ZSA9IGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChcbiAgICAhZG9udFNlbGVjdFZhbHVlLnF1ZXJ5IHx8XG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5rZXkgfHxcbiAgICB0eXBlb2YgZG9udFNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICFkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lIHx8XG4gICAgT2JqZWN0LmtleXMoZG9udFNlbGVjdFZhbHVlKS5sZW5ndGggIT09IDJcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdpbXByb3BlciB1c2FnZSBvZiAkZG9udFNlbGVjdCcpO1xuICB9XG4gIGNvbnN0IGFkZGl0aW9uYWxPcHRpb25zID0ge1xuICAgIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5OiBkb250U2VsZWN0VmFsdWUucXVlcnkucmVkaXJlY3RDbGFzc05hbWVGb3JLZXksXG4gIH07XG5cbiAgaWYgKHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gIH0gZWxzZSBpZiAodGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSkge1xuICAgIGFkZGl0aW9uYWxPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICF0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIGNvbnN0IHJjID0gdGhpcy5jb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gICAgaWYgKHJjICYmIHJjLnN1YnF1ZXJ5TGltaXQgPiAwKSB7XG4gICAgICBhZGRpdGlvbmFsT3B0aW9ucy5saW1pdCA9IHJjLnN1YnF1ZXJ5TGltaXQ7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY2hpbGRDb250ZXh0ID0geyAuLi50aGlzLmNvbnRleHQsIF9zdWJxdWVyeURlcHRoOiAodGhpcy5jb250ZXh0Ll9zdWJxdWVyeURlcHRoIHx8IDApICsgMSB9O1xuICBjb25zdCBzdWJxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgbWV0aG9kOiBSZXN0UXVlcnkuTWV0aG9kLmZpbmQsXG4gICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICBhdXRoOiB0aGlzLmF1dGgsXG4gICAgY2xhc3NOYW1lOiBkb250U2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIHJlc3RXaGVyZTogZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIHJlc3RPcHRpb25zOiBhZGRpdGlvbmFsT3B0aW9ucyxcbiAgICBjb250ZXh0OiBjaGlsZENvbnRleHQsXG4gIH0pO1xuXG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtRG9udFNlbGVjdChkb250U2VsZWN0T2JqZWN0LCBkb250U2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkZG9udFNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgfSk7XG59O1xuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5jbGVhblJlc3VsdEF1dGhEYXRhID0gZnVuY3Rpb24gKHJlc3VsdCkge1xuICBkZWxldGUgcmVzdWx0LnBhc3N3b3JkO1xuICBpZiAocmVzdWx0LmF1dGhEYXRhKSB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgIGlmIChyZXN1bHQuYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICAgIGRlbGV0ZSByZXN1bHQuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKE9iamVjdC5rZXlzKHJlc3VsdC5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuYXV0aERhdGE7XG4gICAgfVxuICB9XG59O1xuXG5jb25zdCByZXBsYWNlRXF1YWxpdHlDb25zdHJhaW50ID0gY29uc3RyYWludCA9PiB7XG4gIGlmICh0eXBlb2YgY29uc3RyYWludCAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gY29uc3RyYWludDtcbiAgfVxuICBjb25zdCBlcXVhbFRvT2JqZWN0ID0ge307XG4gIGxldCBoYXNEaXJlY3RDb25zdHJhaW50ID0gZmFsc2U7XG4gIGxldCBoYXNPcGVyYXRvckNvbnN0cmFpbnQgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBrZXkgaW4gY29uc3RyYWludCkge1xuICAgIGlmIChrZXkuaW5kZXhPZignJCcpICE9PSAwKSB7XG4gICAgICBoYXNEaXJlY3RDb25zdHJhaW50ID0gdHJ1ZTtcbiAgICAgIGVxdWFsVG9PYmplY3Rba2V5XSA9IGNvbnN0cmFpbnRba2V5XTtcbiAgICB9IGVsc2Uge1xuICAgICAgaGFzT3BlcmF0b3JDb25zdHJhaW50ID0gdHJ1ZTtcbiAgICB9XG4gIH1cbiAgaWYgKGhhc0RpcmVjdENvbnN0cmFpbnQgJiYgaGFzT3BlcmF0b3JDb25zdHJhaW50KSB7XG4gICAgY29uc3RyYWludFsnJGVxJ10gPSBlcXVhbFRvT2JqZWN0O1xuICAgIE9iamVjdC5rZXlzKGVxdWFsVG9PYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgIGRlbGV0ZSBjb25zdHJhaW50W2tleV07XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGNvbnN0cmFpbnQ7XG59O1xuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlRXF1YWxpdHkgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0eXBlb2YgdGhpcy5yZXN0V2hlcmUgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHRoaXMucmVzdFdoZXJlKSB7XG4gICAgdGhpcy5yZXN0V2hlcmVba2V5XSA9IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQodGhpcy5yZXN0V2hlcmVba2V5XSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGV0aGVyIGl0IHdhcyBzdWNjZXNzZnVsLlxuLy8gUG9wdWxhdGVzIHRoaXMucmVzcG9uc2Ugd2l0aCBhbiBvYmplY3QgdGhhdCBvbmx5IGhhcyAncmVzdWx0cycuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5GaW5kID0gYXN5bmMgZnVuY3Rpb24gKG9wdGlvbnMgPSB7fSkge1xuICBpZiAodGhpcy5maW5kT3B0aW9ucy5saW1pdCA9PT0gMCkge1xuICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3VsdHM6IFtdIH07XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIGNvbnN0IGZpbmRPcHRpb25zID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5maW5kT3B0aW9ucyk7XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICBmaW5kT3B0aW9ucy5rZXlzID0gdGhpcy5rZXlzLm1hcChrZXkgPT4ge1xuICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpWzBdO1xuICAgIH0pO1xuICAgIC8vIFdoZW4gc2VsZWN0aW5nIGBhdXRoRGF0YWAgb24gYF9Vc2VyYCwgYWxzbyBhZGQgdGhlIGludGVybmFsIGF1dGggZGF0YSBmaWVsZHNcbiAgICAvLyAoZS5nLiBgX2F1dGhfZGF0YV9mYWNlYm9va2ApIGZvciBlYWNoIGNvbmZpZ3VyZWQgYXV0aCBwcm92aWRlci4gSW4gTW9uZ29EQixcbiAgICAvLyBgYXV0aERhdGFgIGlzIHN0b3JlZCBhcyBpbmRpdmlkdWFsIGBfYXV0aF9kYXRhXzxwcm92aWRlcj5gIGZpZWxkcywgc28gdGhlXG4gICAgLy8gcHJvamVjdGlvbiBmb3IgYGF1dGhEYXRhYCBhbG9uZSB3b24ndCBtYXRjaCB0aGVtLiBBZGRpbmcgYm90aCBlbnN1cmVzIGl0XG4gICAgLy8gd29ya3MgYWNyb3NzIGFsbCBkYXRhYmFzZSBhZGFwdGVyczogTW9uZ28gdXNlcyBgX2F1dGhfZGF0YV8qYCBmaWVsZHMsXG4gICAgLy8gUG9zdGdyZXMgdXNlcyB0aGUgYGF1dGhEYXRhYCBjb2x1bW4gZGlyZWN0bHkuXG4gICAgLy9cbiAgICAvLyBOb3RlOiBXaGVuIHNlbGVjdGluZyBgYXV0aERhdGFgLCBvbmx5IGF1dGggZGF0YSBvZiBjdXJyZW50bHkgY29uZmlndXJlZFxuICAgIC8vIHByb3ZpZGVycyBpcyByZXR1cm5lZC4gQXV0aCBkYXRhIGVudHJpZXMgb2YgcHJvdmlkZXJzIHRoYXQgYXJlIG5vIGxvbmdlclxuICAgIC8vIGNvbmZpZ3VyZWQgd29uJ3QgYmUgaW5jbHVkZWQuIFRvIHJldHVybiBhbGwgYXV0aCBkYXRhIHJlZ2FyZGxlc3Mgb2YgdGhlXG4gICAgLy8gcHJvdmlkZXIgY29uZmlndXJhdGlvbiwgZG8gbm90IHVzZSBgYXV0aERhdGFgIGFzIGEgc2VsZWN0ZWQga2V5LlxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJiBmaW5kT3B0aW9ucy5rZXlzLmluY2x1ZGVzKCdhdXRoRGF0YScpKSB7XG4gICAgICBjb25zdCBwcm92aWRlcnMgPSB0aGlzLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0UHJvdmlkZXJzKCk7XG4gICAgICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIHByb3ZpZGVycykge1xuICAgICAgICBjb25zdCBrZXkgPSBgX2F1dGhfZGF0YV8ke3Byb3ZpZGVyfWA7XG4gICAgICAgIGlmICghZmluZE9wdGlvbnMua2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICAgICAgZmluZE9wdGlvbnMua2V5cy5wdXNoKGtleSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgaWYgKG9wdGlvbnMub3ApIHtcbiAgICBmaW5kT3B0aW9ucy5vcCA9IG9wdGlvbnMub3A7XG4gIH1cbiAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQodGhpcy5jbGFzc05hbWUsIHRoaXMucmVzdFdoZXJlLCBmaW5kT3B0aW9ucywgdGhpcy5hdXRoKTtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmICFmaW5kT3B0aW9ucy5leHBsYWluKSB7XG4gICAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICAgIHRoaXMuY2xlYW5SZXN1bHRBdXRoRGF0YShyZXN1bHQpO1xuICAgIH1cbiAgfVxuXG4gIGF3YWl0IHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCByZXN1bHRzKTtcblxuICBpZiAodGhpcy5yZWRpcmVjdENsYXNzTmFtZSkge1xuICAgIGZvciAodmFyIHIgb2YgcmVzdWx0cykge1xuICAgICAgci5jbGFzc05hbWUgPSB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lO1xuICAgIH1cbiAgfVxuICB0aGlzLnJlc3BvbnNlID0geyByZXN1bHRzOiByZXN1bHRzIH07XG59O1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hldGhlciBpdCB3YXMgc3VjY2Vzc2Z1bC5cbi8vIFBvcHVsYXRlcyB0aGlzLnJlc3BvbnNlLmNvdW50IHdpdGggdGhlIGNvdW50XG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5ydW5Db3VudCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmRvQ291bnQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5maW5kT3B0aW9ucy5jb3VudCA9IHRydWU7XG4gIGRlbGV0ZSB0aGlzLmZpbmRPcHRpb25zLnNraXA7XG4gIGRlbGV0ZSB0aGlzLmZpbmRPcHRpb25zLmxpbWl0O1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIHRoaXMuZmluZE9wdGlvbnMpLnRoZW4oYyA9PiB7XG4gICAgdGhpcy5yZXNwb25zZS5jb3VudCA9IGM7XG4gIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUuZGVueVByb3RlY3RlZEZpZWxkcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzY2hlbWFDb250cm9sbGVyID0gYXdhaXQgdGhpcy5jb25maWcuZGF0YWJhc2UubG9hZFNjaGVtYSgpO1xuICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPVxuICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmFkZFByb3RlY3RlZEZpZWxkcyhcbiAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRoaXMucmVzdFdoZXJlLFxuICAgICAgdGhpcy5maW5kT3B0aW9ucy5hY2wsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLmZpbmRPcHRpb25zXG4gICAgKSB8fCBbXTtcbiAgY29uc3QgY2hlY2tXaGVyZSA9ICh3aGVyZSkgPT4ge1xuICAgIGlmICh0eXBlb2Ygd2hlcmUgIT09ICdvYmplY3QnIHx8IHdoZXJlID09PSBudWxsKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3Qgd2hlcmVLZXkgb2YgT2JqZWN0LmtleXMod2hlcmUpKSB7XG4gICAgICBjb25zdCByb290RmllbGQgPSB3aGVyZUtleS5zcGxpdCgnLicpWzBdO1xuICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyh3aGVyZUtleSkgfHwgcHJvdGVjdGVkRmllbGRzLmluY2x1ZGVzKHJvb3RGaWVsZCkpIHtcbiAgICAgICAgdGhyb3cgY3JlYXRlU2FuaXRpemVkRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICBgVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIHF1ZXJ5ICR7d2hlcmVLZXl9IG9uIGNsYXNzICR7dGhpcy5jbGFzc05hbWV9YCxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IG9wIG9mIFsnJG9yJywgJyRhbmQnLCAnJG5vciddKSB7XG4gICAgICBpZiAod2hlcmVbb3BdICE9PSB1bmRlZmluZWQgJiYgIUFycmF5LmlzQXJyYXkod2hlcmVbb3BdKSkge1xuICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGAke29wfSBtdXN0IGJlIGFuIGFycmF5YCxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkod2hlcmVbb3BdKSkge1xuICAgICAgICB3aGVyZVtvcF0uZm9yRWFjaChzdWJRdWVyeSA9PiBjaGVja1doZXJlKHN1YlF1ZXJ5KSk7XG4gICAgICB9XG4gICAgfVxuICB9O1xuICBjaGVja1doZXJlKHRoaXMucmVzdFdoZXJlKTtcblxuICAvLyBDaGVjayBzb3J0IGtleXMgYWdhaW5zdCBwcm90ZWN0ZWQgZmllbGRzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnNvcnQpIHtcbiAgICBmb3IgKGNvbnN0IHNvcnRLZXkgb2YgT2JqZWN0LmtleXModGhpcy5maW5kT3B0aW9ucy5zb3J0KSkge1xuICAgICAgY29uc3Qgcm9vdEZpZWxkID0gc29ydEtleS5zcGxpdCgnLicpWzBdO1xuICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhzb3J0S2V5KSB8fCBwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMocm9vdEZpZWxkKSkge1xuICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgIGBUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gc29ydCBieSAke3NvcnRLZXl9IG9uIGNsYXNzICR7dGhpcy5jbGFzc05hbWV9YCxcbiAgICAgICAgICB0aGlzLmNvbmZpZ1xuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuLy8gQXVnbWVudHMgdGhpcy5yZXNwb25zZSB3aXRoIGFsbCBwb2ludGVycyBvbiBhbiBvYmplY3Rcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGVBbGwgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5pbmNsdWRlQWxsKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5sb2FkU2NoZW1hKClcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgY29uc3QgaW5jbHVkZUZpZWxkcyA9IFtdO1xuICAgICAgY29uc3Qga2V5RmllbGRzID0gW107XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHNjaGVtYS5maWVsZHMpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIChzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykgfHxcbiAgICAgICAgICAoc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnQXJyYXknKVxuICAgICAgICApIHtcbiAgICAgICAgICBpbmNsdWRlRmllbGRzLnB1c2goW2ZpZWxkXSk7XG4gICAgICAgICAga2V5RmllbGRzLnB1c2goZmllbGQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBBZGQgZmllbGRzIHRvIGluY2x1ZGUsIGtleXMsIHJlbW92ZSBkdXBzXG4gICAgICB0aGlzLmluY2x1ZGUgPSBbLi4ubmV3IFNldChbLi4udGhpcy5pbmNsdWRlLCAuLi5pbmNsdWRlRmllbGRzXSldO1xuICAgICAgLy8gaWYgdGhpcy5rZXlzIG5vdCBzZXQsIHRoZW4gYWxsIGtleXMgYXJlIGFscmVhZHkgaW5jbHVkZWRcbiAgICAgIGlmICh0aGlzLmtleXMpIHtcbiAgICAgICAgdGhpcy5rZXlzID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMua2V5cywgLi4ua2V5RmllbGRzXSldO1xuICAgICAgfVxuICAgIH0pO1xufTtcblxuX1Vuc2FmZVJlc3RRdWVyeS5wcm90b3R5cGUudmFsaWRhdGVJbmNsdWRlQ29tcGxleGl0eSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuYXV0aC5pc01hc3RlciB8fCB0aGlzLmF1dGguaXNNYWludGVuYW5jZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByYyA9IHRoaXMuY29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICBpZiAoIXJjKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyYy5pbmNsdWRlRGVwdGggIT09IC0xICYmIHRoaXMuaW5jbHVkZSAmJiB0aGlzLmluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG1heERlcHRoID0gTWF0aC5tYXgoLi4udGhpcy5pbmNsdWRlLm1hcChwYXRoID0+IHBhdGgubGVuZ3RoKSk7XG4gICAgaWYgKG1heERlcHRoID4gcmMuaW5jbHVkZURlcHRoKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYEluY2x1ZGUgZGVwdGggb2YgJHttYXhEZXB0aH0gZXhjZWVkcyBtYXhpbXVtIGFsbG93ZWQgZGVwdGggb2YgJHtyYy5pbmNsdWRlRGVwdGh9YDtcbiAgICAgIGxvZ2dlci53YXJuKG1lc3NhZ2UpO1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIG1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuICBpZiAocmMuaW5jbHVkZUNvdW50ICE9PSAtMSAmJiB0aGlzLmluY2x1ZGUgJiYgdGhpcy5pbmNsdWRlLmxlbmd0aCA+IHJjLmluY2x1ZGVDb3VudCkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBgTnVtYmVyIG9mIGluY2x1ZGUgZmllbGRzICgke3RoaXMuaW5jbHVkZS5sZW5ndGh9KSBleGNlZWRzIG1heGltdW0gYWxsb3dlZCAoJHtyYy5pbmNsdWRlQ291bnR9KWA7XG4gICAgbG9nZ2VyLndhcm4obWVzc2FnZSk7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIG1lc3NhZ2UpO1xuICB9XG59O1xuXG4vLyBVcGRhdGVzIHByb3BlcnR5IGB0aGlzLmtleXNgIHRvIGNvbnRhaW4gYWxsIGtleXMgYnV0IHRoZSBvbmVzIHVuc2VsZWN0ZWQuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVFeGNsdWRlS2V5cyA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmV4Y2x1ZGVLZXlzKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aGlzLmtleXMpIHtcbiAgICB0aGlzLmtleXMgPSB0aGlzLmtleXMuZmlsdGVyKGsgPT4gIXRoaXMuZXhjbHVkZUtleXMuaW5jbHVkZXMoaykpO1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAubG9hZFNjaGVtYSgpXG4gICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYSh0aGlzLmNsYXNzTmFtZSkpXG4gICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpO1xuICAgICAgdGhpcy5rZXlzID0gZmllbGRzLmZpbHRlcihrID0+ICF0aGlzLmV4Y2x1ZGVLZXlzLmluY2x1ZGVzKGspKTtcbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBkYXRhIGF0IHRoZSBwYXRocyBwcm92aWRlZCBpbiB0aGlzLmluY2x1ZGUuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlID0gYXN5bmMgZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5pbmNsdWRlLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaW5kZXhlZFJlc3VsdHMgPSB0aGlzLnJlc3BvbnNlLnJlc3VsdHMucmVkdWNlKChpbmRleGVkLCByZXN1bHQsIGkpID0+IHtcbiAgICBpbmRleGVkW3Jlc3VsdC5vYmplY3RJZF0gPSBpO1xuICAgIHJldHVybiBpbmRleGVkO1xuICB9LCB7fSk7XG5cbiAgLy8gQnVpbGQgdGhlIGV4ZWN1dGlvbiB0cmVlXG4gIGNvbnN0IGV4ZWN1dGlvblRyZWUgPSB7fVxuICB0aGlzLmluY2x1ZGUuZm9yRWFjaChwYXRoID0+IHtcbiAgICBsZXQgY3VycmVudCA9IGV4ZWN1dGlvblRyZWU7XG4gICAgcGF0aC5mb3JFYWNoKChub2RlKSA9PiB7XG4gICAgICBpZiAoIWN1cnJlbnRbbm9kZV0pIHtcbiAgICAgICAgY3VycmVudFtub2RlXSA9IHtcbiAgICAgICAgICBwYXRoLFxuICAgICAgICAgIGNoaWxkcmVuOiB7fVxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY3VycmVudCA9IGN1cnJlbnRbbm9kZV0uY2hpbGRyZW5cbiAgICB9KTtcbiAgfSk7XG5cbiAgY29uc3QgcmVjdXJzaXZlRXhlY3V0aW9uVHJlZSA9IGFzeW5jICh0cmVlTm9kZSkgPT4ge1xuICAgIGNvbnN0IHsgcGF0aCwgY2hpbGRyZW4gfSA9IHRyZWVOb2RlO1xuICAgIGNvbnN0IHBhdGhSZXNwb25zZSA9IGluY2x1ZGVQYXRoKFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLnJlc3BvbnNlLFxuICAgICAgcGF0aCxcbiAgICAgIHRoaXMuY29udGV4dCxcbiAgICAgIHRoaXMucmVzdE9wdGlvbnMsXG4gICAgICB0aGlzLFxuICAgICk7XG4gICAgaWYgKHBhdGhSZXNwb25zZS50aGVuKSB7XG4gICAgICBjb25zdCBuZXdSZXNwb25zZSA9IGF3YWl0IHBhdGhSZXNwb25zZVxuICAgICAgbmV3UmVzcG9uc2UucmVzdWx0cy5mb3JFYWNoKG5ld09iamVjdCA9PiB7XG4gICAgICAgIC8vIFdlIGh5ZHJhdGUgdGhlIHJvb3Qgb2YgZWFjaCByZXN1bHQgd2l0aCBzdWIgcmVzdWx0c1xuICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHNbaW5kZXhlZFJlc3VsdHNbbmV3T2JqZWN0Lm9iamVjdElkXV1bcGF0aFswXV0gPSBuZXdPYmplY3RbcGF0aFswXV07XG4gICAgICB9KVxuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoT2JqZWN0LnZhbHVlcyhjaGlsZHJlbikubWFwKHJlY3Vyc2l2ZUV4ZWN1dGlvblRyZWUpKTtcbiAgfVxuXG4gIGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC52YWx1ZXMoZXhlY3V0aW9uVHJlZSkubWFwKHJlY3Vyc2l2ZUV4ZWN1dGlvblRyZWUpKTtcbiAgdGhpcy5pbmNsdWRlID0gW11cbn07XG5cbi8vUmV0dXJucyBhIHByb21pc2Ugb2YgYSBwcm9jZXNzZWQgc2V0IG9mIHJlc3VsdHNcbl9VbnNhZmVSZXN0UXVlcnkucHJvdG90eXBlLnJ1bkFmdGVyRmluZFRyaWdnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXRoaXMucnVuQWZ0ZXJGaW5kKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgaWYgKCFoYXNBZnRlckZpbmRIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFNraXAgQWdncmVnYXRlIGFuZCBEaXN0aW5jdCBRdWVyaWVzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnBpcGVsaW5lIHx8IHRoaXMuZmluZE9wdGlvbnMuZGlzdGluY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjb25zdCBqc29uID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5yZXN0T3B0aW9ucyk7XG4gIGpzb24ud2hlcmUgPSB0aGlzLnJlc3RXaGVyZTtcbiAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeSh0aGlzLmNsYXNzTmFtZSk7XG4gIHBhcnNlUXVlcnkud2l0aEpTT04oanNvbik7XG4gIC8vIFJ1biBhZnRlckZpbmQgdHJpZ2dlciBhbmQgc2V0IHRoZSBuZXcgcmVzdWx0c1xuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB0aGlzLnJlc3BvbnNlLnJlc3VsdHMsXG4gICAgICB0aGlzLmNvbmZpZyxcbiAgICAgIHBhcnNlUXVlcnksXG4gICAgICB0aGlzLmNvbnRleHQsXG4gICAgICB0aGlzLmlzR2V0XG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgLy8gRW5zdXJlIHdlIHByb3Blcmx5IHNldCB0aGUgY2xhc3NOYW1lIGJhY2tcbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICAgICAgb2JqZWN0ID0gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3QuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0O1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHM7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5fVW5zYWZlUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVBdXRoQWRhcHRlcnMgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNsYXNzTmFtZSAhPT0gJ19Vc2VyJyB8fCB0aGlzLmZpbmRPcHRpb25zLmV4cGxhaW4pIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgdGhpcy5yZXNwb25zZS5yZXN1bHRzLm1hcChyZXN1bHQgPT5cbiAgICAgIHRoaXMuY29uZmlnLmF1dGhEYXRhTWFuYWdlci5ydW5BZnRlckZpbmQoXG4gICAgICAgIHsgY29uZmlnOiB0aGlzLmNvbmZpZywgYXV0aDogdGhpcy5hdXRoIH0sXG4gICAgICAgIHJlc3VsdC5hdXRoRGF0YVxuICAgICAgKVxuICAgIClcbiAgKTtcbn07XG5cbi8vIEFkZHMgaW5jbHVkZWQgdmFsdWVzIHRvIHRoZSByZXNwb25zZS5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkIG5hbWVzLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGFuIGF1Z21lbnRlZCByZXNwb25zZS5cbmZ1bmN0aW9uIGluY2x1ZGVQYXRoKGNvbmZpZywgYXV0aCwgcmVzcG9uc2UsIHBhdGgsIGNvbnRleHQsIHJlc3RPcHRpb25zID0ge30pIHtcbiAgdmFyIHBvaW50ZXJzID0gZmluZFBvaW50ZXJzKHJlc3BvbnNlLnJlc3VsdHMsIHBhdGgpO1xuICBpZiAocG9pbnRlcnMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgcG9pbnRlcnNIYXNoID0ge307XG4gIGZvciAodmFyIHBvaW50ZXIgb2YgcG9pbnRlcnMpIHtcbiAgICBpZiAoIXBvaW50ZXIpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjbGFzc05hbWUgPSBwb2ludGVyLmNsYXNzTmFtZTtcbiAgICAvLyBvbmx5IGluY2x1ZGUgdGhlIGdvb2QgcG9pbnRlcnNcbiAgICBpZiAoY2xhc3NOYW1lKSB7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSA9IHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdIHx8IG5ldyBTZXQoKTtcbiAgICAgIHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdLmFkZChwb2ludGVyLm9iamVjdElkKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgaW5jbHVkZVJlc3RPcHRpb25zID0ge307XG4gIGlmIChyZXN0T3B0aW9ucy5rZXlzKSB7XG4gICAgY29uc3Qga2V5cyA9IG5ldyBTZXQocmVzdE9wdGlvbnMua2V5cy5zcGxpdCgnLCcpKTtcbiAgICBjb25zdCBrZXlTZXQgPSBBcnJheS5mcm9tKGtleXMpLnJlZHVjZSgoc2V0LCBrZXkpID0+IHtcbiAgICAgIGNvbnN0IGtleVBhdGggPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGxldCBpID0gMDtcbiAgICAgIGZvciAoaTsgaSA8IHBhdGgubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgaWYgKHBhdGhbaV0gIT0ga2V5UGF0aFtpXSkge1xuICAgICAgICAgIHJldHVybiBzZXQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChpIDwga2V5UGF0aC5sZW5ndGgpIHtcbiAgICAgICAgc2V0LmFkZChrZXlQYXRoW2ldKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZXQ7XG4gICAgfSwgbmV3IFNldCgpKTtcbiAgICBpZiAoa2V5U2V0LnNpemUgPiAwKSB7XG4gICAgICBpbmNsdWRlUmVzdE9wdGlvbnMua2V5cyA9IEFycmF5LmZyb20oa2V5U2V0KS5qb2luKCcsJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzKSB7XG4gICAgY29uc3QgZXhjbHVkZUtleXMgPSBuZXcgU2V0KHJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzLnNwbGl0KCcsJykpO1xuICAgIGNvbnN0IGV4Y2x1ZGVLZXlTZXQgPSBBcnJheS5mcm9tKGV4Y2x1ZGVLZXlzKS5yZWR1Y2UoKHNldCwga2V5KSA9PiB7XG4gICAgICBjb25zdCBrZXlQYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBmb3IgKGk7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChwYXRoW2ldICE9IGtleVBhdGhbaV0pIHtcbiAgICAgICAgICByZXR1cm4gc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaSA9PSBrZXlQYXRoLmxlbmd0aCAtIDEpIHtcbiAgICAgICAgc2V0LmFkZChrZXlQYXRoW2ldKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZXQ7XG4gICAgfSwgbmV3IFNldCgpKTtcbiAgICBpZiAoZXhjbHVkZUtleVNldC5zaXplID4gMCkge1xuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zLmV4Y2x1ZGVLZXlzID0gQXJyYXkuZnJvbShleGNsdWRlS2V5U2V0KS5qb2luKCcsJyk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgIGluY2x1ZGVSZXN0T3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZTtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlO1xuICB9IGVsc2UgaWYgKHJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlKSB7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLnJlYWRQcmVmZXJlbmNlID0gcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2U7XG4gIH1cbiAgY29uc3QgcXVlcnlQcm9taXNlcyA9IE9iamVjdC5rZXlzKHBvaW50ZXJzSGFzaCkubWFwKGFzeW5jIGNsYXNzTmFtZSA9PiB7XG4gICAgY29uc3Qgb2JqZWN0SWRzID0gQXJyYXkuZnJvbShwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSk7XG4gICAgbGV0IHdoZXJlO1xuICAgIGlmIChvYmplY3RJZHMubGVuZ3RoID09PSAxKSB7XG4gICAgICB3aGVyZSA9IHsgb2JqZWN0SWQ6IG9iamVjdElkc1swXSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICB3aGVyZSA9IHsgb2JqZWN0SWQ6IHsgJGluOiBvYmplY3RJZHMgfSB9O1xuICAgIH1cbiAgICBjb25zdCBxdWVyeSA9IGF3YWl0IFJlc3RRdWVyeSh7XG4gICAgICBtZXRob2Q6IG9iamVjdElkcy5sZW5ndGggPT09IDEgPyBSZXN0UXVlcnkuTWV0aG9kLmdldCA6IFJlc3RRdWVyeS5NZXRob2QuZmluZCxcbiAgICAgIGNvbmZpZyxcbiAgICAgIGF1dGgsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICByZXN0V2hlcmU6IHdoZXJlLFxuICAgICAgcmVzdE9wdGlvbnM6IGluY2x1ZGVSZXN0T3B0aW9ucyxcbiAgICAgIGNvbnRleHQ6IGNvbnRleHQsXG4gICAgfSk7XG4gICAgcmV0dXJuIHF1ZXJ5LmV4ZWN1dGUoeyBvcDogJ2dldCcgfSkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXN1bHRzKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gR2V0IHRoZSBvYmplY3RzIGZvciBhbGwgdGhlc2Ugb2JqZWN0IGlkc1xuICByZXR1cm4gUHJvbWlzZS5hbGwocXVlcnlQcm9taXNlcykudGhlbihyZXNwb25zZXMgPT4ge1xuICAgIHZhciByZXBsYWNlID0gcmVzcG9uc2VzLnJlZHVjZSgocmVwbGFjZSwgaW5jbHVkZVJlc3BvbnNlKSA9PiB7XG4gICAgICBmb3IgKHZhciBvYmogb2YgaW5jbHVkZVJlc3BvbnNlLnJlc3VsdHMpIHtcbiAgICAgICAgb2JqLl9fdHlwZSA9ICdPYmplY3QnO1xuICAgICAgICBvYmouY2xhc3NOYW1lID0gaW5jbHVkZVJlc3BvbnNlLmNsYXNzTmFtZTtcblxuICAgICAgICBpZiAob2JqLmNsYXNzTmFtZSA9PSAnX1VzZXInICYmICFhdXRoLmlzTWFzdGVyKSB7XG4gICAgICAgICAgZGVsZXRlIG9iai5zZXNzaW9uVG9rZW47XG4gICAgICAgICAgZGVsZXRlIG9iai5hdXRoRGF0YTtcbiAgICAgICAgfVxuICAgICAgICByZXBsYWNlW29iai5vYmplY3RJZF0gPSBvYmo7XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVwbGFjZTtcbiAgICB9LCB7fSk7XG4gICAgdmFyIHJlc3AgPSB7XG4gICAgICByZXN1bHRzOiByZXBsYWNlUG9pbnRlcnMocmVzcG9uc2UucmVzdWx0cywgcGF0aCwgcmVwbGFjZSksXG4gICAgfTtcbiAgICBpZiAocmVzcG9uc2UuY291bnQpIHtcbiAgICAgIHJlc3AuY291bnQgPSByZXNwb25zZS5jb3VudDtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3QgdG8gZmluZCBwb2ludGVycyBpbiwgb3Jcbi8vIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBJZiB0aGUgcGF0aCB5aWVsZHMgdGhpbmdzIHRoYXQgYXJlbid0IHBvaW50ZXJzLCB0aGlzIHRocm93cyBhbiBlcnJvci5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIFJldHVybnMgYSBsaXN0IG9mIHBvaW50ZXJzIGluIFJFU1QgZm9ybWF0LlxuZnVuY3Rpb24gZmluZFBvaW50ZXJzKG9iamVjdCwgcGF0aCkge1xuICBpZiAoQXJyYXkuaXNBcnJheShvYmplY3QpKSB7XG4gICAgcmV0dXJuIG9iamVjdC5tYXAoeCA9PiBmaW5kUG9pbnRlcnMoeCwgcGF0aCkpLmZsYXQoKTtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09IDApIHtcbiAgICBpZiAob2JqZWN0ID09PSBudWxsIHx8IG9iamVjdC5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gW29iamVjdF07XG4gICAgfVxuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIHJldHVybiBmaW5kUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0cyB0byByZXBsYWNlIHBvaW50ZXJzXG4vLyBpbiwgb3IgaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIHJlcGxhY2UgaXMgYSBtYXAgZnJvbSBvYmplY3QgaWQgLT4gb2JqZWN0LlxuLy8gUmV0dXJucyBzb21ldGhpbmcgYW5hbG9nb3VzIHRvIG9iamVjdCwgYnV0IHdpdGggdGhlIGFwcHJvcHJpYXRlXG4vLyBwb2ludGVycyBpbmZsYXRlZC5cbmZ1bmN0aW9uIHJlcGxhY2VQb2ludGVycyhvYmplY3QsIHBhdGgsIHJlcGxhY2UpIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkob2JqZWN0KSkge1xuICAgIHJldHVybiBvYmplY3RcbiAgICAgIC5tYXAob2JqID0+IHJlcGxhY2VQb2ludGVycyhvYmosIHBhdGgsIHJlcGxhY2UpKVxuICAgICAgLmZpbHRlcihvYmogPT4gdHlwZW9mIG9iaiAhPT0gJ3VuZGVmaW5lZCcpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvYmplY3QgIT09ICdvYmplY3QnIHx8ICFvYmplY3QpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKG9iamVjdCAmJiBvYmplY3QuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIHJldHVybiByZXBsYWNlW29iamVjdC5vYmplY3RJZF07XG4gICAgfVxuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICB2YXIgc3Vib2JqZWN0ID0gb2JqZWN0W3BhdGhbMF1dO1xuICBpZiAoIXN1Ym9iamVjdCkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cbiAgdmFyIG5ld3N1YiA9IHJlcGxhY2VQb2ludGVycyhzdWJvYmplY3QsIHBhdGguc2xpY2UoMSksIHJlcGxhY2UpO1xuICB2YXIgYW5zd2VyID0ge307XG4gIGZvciAodmFyIGtleSBpbiBvYmplY3QpIHtcbiAgICBpZiAoa2V5ID09IHBhdGhbMF0pIHtcbiAgICAgIGFuc3dlcltrZXldID0gbmV3c3ViO1xuICAgIH0gZWxzZSB7XG4gICAgICBhbnN3ZXJba2V5XSA9IG9iamVjdFtrZXldO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYW5zd2VyO1xufVxuXG4vLyBGaW5kcyBhIHN1Ym9iamVjdCB0aGF0IGhhcyB0aGUgZ2l2ZW4ga2V5LCBpZiB0aGVyZSBpcyBvbmUuXG4vLyBSZXR1cm5zIHVuZGVmaW5lZCBvdGhlcndpc2UuXG5mdW5jdGlvbiBmaW5kT2JqZWN0V2l0aEtleShyb290LCBrZXkpIHtcbiAgaWYgKHR5cGVvZiByb290ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoQXJyYXkuaXNBcnJheShyb290KSkge1xuICAgIGZvciAodmFyIGl0ZW0gb2Ygcm9vdCkge1xuICAgICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkoaXRlbSwga2V5KTtcbiAgICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQXJyYXlzIGFyZSBmdWxseSB0cmF2ZXJzZWQgYWJvdmU7IHJldHVybmluZyBoZXJlIGF2b2lkcyByZS13YWxraW5nIHRoZSBzYW1lXG4gICAgLy8gZWxlbWVudHMgdGhyb3VnaCB0aGUgYGZvciAoc3Via2V5IGluIHJvb3QpYCBsb29wIGJlbG93LCB3aGljaCB3b3VsZCBtYWtlIHRoaXNcbiAgICAvLyBmdW5jdGlvbiBPKDJebikgZm9yIG5lc3RlZCBhcnJheXMgKGUuZy4gZGVlcGx5IG5lc3RlZCAkb3IvJGFuZC8kbm9yKS5cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHJvb3QgJiYgcm9vdFtrZXldKSB7XG4gICAgcmV0dXJuIHJvb3Q7XG4gIH1cbiAgZm9yICh2YXIgc3Via2V5IGluIHJvb3QpIHtcbiAgICBjb25zdCBhbnN3ZXIgPSBmaW5kT2JqZWN0V2l0aEtleShyb290W3N1YmtleV0sIGtleSk7XG4gICAgaWYgKGFuc3dlcikge1xuICAgICAgcmV0dXJuIGFuc3dlcjtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBSZXN0UXVlcnk7XG4vLyBGb3IgdGVzdHNcbm1vZHVsZS5leHBvcnRzLl9VbnNhZmVSZXN0UXVlcnkgPSBfVW5zYWZlUmVzdFF1ZXJ5O1xuIl0sIm1hcHBpbmdzIjoiOztBQUFBO0FBQ0E7O0FBRUEsSUFBSUEsZ0JBQWdCLEdBQUdDLE9BQU8sQ0FBQyxnQ0FBZ0MsQ0FBQztBQUNoRSxJQUFJQyxLQUFLLEdBQUdELE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQ0MsS0FBSztBQUN2QyxJQUFJQyxNQUFNLEdBQUdGLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQ0csT0FBTztBQUN4QyxNQUFNQyxRQUFRLEdBQUdKLE9BQU8sQ0FBQyxZQUFZLENBQUM7QUFDdEMsTUFBTTtFQUFFSztBQUFjLENBQUMsR0FBR0wsT0FBTyxDQUFDLDZCQUE2QixDQUFDO0FBQ2hFLE1BQU1N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