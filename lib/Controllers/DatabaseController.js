"use strict";

var _node = require("parse/node");
var _lodash = _interopRequireDefault(require("lodash"));
var _intersect = _interopRequireDefault(require("intersect"));
var _logger = _interopRequireDefault(require("../logger"));
var _Utils = _interopRequireDefault(require("../Utils"));
var SchemaController = _interopRequireWildcard(require("./SchemaController"));
var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");
var _MongoStorageAdapter = _interopRequireDefault(require("../Adapters/Storage/Mongo/MongoStorageAdapter"));
var _PostgresStorageAdapter = _interopRequireDefault(require("../Adapters/Storage/Postgres/PostgresStorageAdapter"));
var _SchemaCache = _interopRequireDefault(require("../Adapters/Cache/SchemaCache"));
var _Error = require("../Error");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// A database adapter that works with data exported from the hosted
// Parse database.
// -disable-next
// -disable-next
// -disable-next
// Query operators that always pass validation regardless of auth level.
const queryOperators = ['$and', '$or', '$nor'];

// Registry of internal fields with access permissions.
// Internal fields are never directly writable by clients, so clientWrite is omitted.
// - clientRead: any client can use this field in queries
// - masterRead: master key can use this field in queries
// - masterWrite: master key can use this field in updates
const internalFields = {
  _rperm: {
    clientRead: true,
    masterRead: true,
    masterWrite: true
  },
  _wperm: {
    clientRead: true,
    masterRead: true,
    masterWrite: true
  },
  _hashed_password: {
    clientRead: false,
    masterRead: false,
    masterWrite: true
  },
  _email_verify_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _perishable_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _perishable_token_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _email_verify_token_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _failed_login_count: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _account_lockout_expires_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _password_changed_at: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _password_history: {
    clientRead: false,
    masterRead: true,
    masterWrite: true
  },
  _tombstone: {
    clientRead: false,
    masterRead: true,
    masterWrite: false
  },
  _session_token: {
    clientRead: false,
    masterRead: true,
    masterWrite: false
  }
  /////////////////////////////////////////////////////////////////////////////////////////////
  // The following fields are not accessed by their _-prefixed name through the API;
  // they are mapped to REST-level names in the adapter layer or handled through
  // separate code paths.
  /////////////////////////////////////////////////////////////////////////////////////////////
  // System fields (mapped to REST-level names):
  // _id (objectId)
  // _created_at (createdAt)
  // _updated_at (updatedAt)
  // _last_used (lastUsed)
  // _expiresAt (expiresAt)
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Legacy ACL format: mapped to/from _rperm/_wperm
  // _acl
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Schema metadata: not data fields, used only for schema configuration
  // _metadata
  // _client_permissions
  /////////////////////////////////////////////////////////////////////////////////////////////
  // Dynamic auth data fields: used only in projections and updates, not in queries
  // _auth_data_<provider>
};

// Derived access lists
const specialQueryKeys = [...queryOperators, ...Object.keys(internalFields).filter(k => internalFields[k].clientRead)];
const specialMasterQueryKeys = [...queryOperators, ...Object.keys(internalFields).filter(k => internalFields[k].masterRead)];
function addWriteACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query);
  //Can't be any existing '_wperm' query, we don't allow client queries on that, no need to $and
  newQuery._wperm = {
    $in: [null, ...acl]
  };
  return newQuery;
}
function addReadACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query);
  //Can't be any existing '_rperm' query, we don't allow client queries on that, no need to $and
  newQuery._rperm = {
    $in: [null, '*', ...acl]
  };
  return newQuery;
}

// Transforms a REST API formatted ACL object to our two-field mongo format.
const transformObjectACL = ({
  ACL,
  ...result
}) => {
  if (!ACL) {
    return result;
  }
  result._wperm = [];
  result._rperm = [];
  for (const entry in ACL) {
    if (ACL[entry].read) {
      result._rperm.push(entry);
    }
    if (ACL[entry].write) {
      result._wperm.push(entry);
    }
  }
  return result;
};

// Error for a logical operator value that is not a non-empty array
const logicalOperatorError = (op, value) => {
  const message = Array.isArray(value) || op === '$nor' ? `Bad ${op} format - use an array of at least 1 value.` : `Bad ${op} format - use an array value.`;
  return new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, message);
};

// Validates the format of logical operators and $options before the query is processed
const validateQueryFormat = query => {
  if (!_Utils.default.isObject(query)) {
    return;
  }
  for (const op of queryOperators) {
    const subQueries = query[op];
    if (subQueries === undefined) {
      continue;
    }
    if (!Array.isArray(subQueries) || subQueries.length === 0) {
      throw logicalOperatorError(op, subQueries);
    }
    for (const subQuery of subQueries) {
      // Unconstrained query sent as empty array by some SDKs
      if (Array.isArray(subQuery) && subQuery.length === 0) {
        continue;
      }
      if (!_Utils.default.isObject(subQuery) || Array.isArray(subQuery)) {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad ${op} format - use an array of objects.`);
      }
      validateQueryFormat(subQuery);
    }
  }
  for (const key of Object.keys(query)) {
    const constraint = query[key];
    if (_Utils.default.isObject(constraint) && constraint.$options !== undefined && constraint.$regex === undefined) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$options requires $regex');
    }
  }
};
const validateQuery = (query, isMaster, isMaintenance, update, options, _depth = 0) => {
  if (isMaintenance) {
    isMaster = true;
  }
  const rc = options?.requestComplexity;
  if (!isMaster && rc && rc.queryDepth !== -1 && _depth > rc.queryDepth) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Query condition nesting depth exceeds maximum allowed depth of ${rc.queryDepth}`);
  }
  if (query.ACL) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Cannot query on ACL.');
  }
  for (const op of queryOperators) {
    if (query[op] === undefined) {
      continue;
    }
    if (!Array.isArray(query[op]) || query[op].length === 0) {
      throw logicalOperatorError(op, query[op]);
    }
    query[op].forEach(value => validateQuery(value, isMaster, isMaintenance, update, options, _depth + 1));
  }
  Object.keys(query).forEach(key => {
    if (query && query[key] && query[key].$regex !== undefined) {
      if (!isMaster && rc && rc.allowRegex === false) {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$regex operator is not allowed');
      }
      if (typeof query[key].$regex !== 'string') {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$regex value must be a string');
      }
      if (query[key].$options !== undefined && typeof query[key].$options !== 'string') {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, '$options value must be a string');
      }
      if (typeof query[key].$options === 'string') {
        if (!query[key].$options.match(/^[imxsu]+$/)) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad $options value for query: ${query[key].$options}`);
        }
      }
    }
    if (!key.match(/^[a-zA-Z][a-zA-Z0-9_\.]*$/) && !specialQueryKeys.includes(key) && !(isMaster && specialMasterQueryKeys.includes(key))) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${key}`);
    }
  });
};

// Filters out any data that shouldn't be on this REST-formatted object.
const filterSensitiveData = (isMaster, isMaintenance, aclGroup, auth, operation, schema, className, protectedFields, object, protectedFieldsOwnerExempt) => {
  let userId = null;
  if (auth && auth.user) {
    userId = auth.user.id;
  }

  // replace protectedFields when using pointer-permissions
  const perms = schema && schema.getClassLevelPermissions ? schema.getClassLevelPermissions(className) : {};
  if (perms) {
    const isReadOperation = ['get', 'find'].indexOf(operation) > -1;
    if (isReadOperation && perms.protectedFields) {
      // extract protectedFields added with the pointer-permission prefix
      const protectedFieldsPointerPerm = Object.keys(perms.protectedFields).filter(key => key.startsWith('userField:')).map(key => {
        return {
          key: key.substring(10),
          value: perms.protectedFields[key]
        };
      });
      const newProtectedFields = [];
      let overrideProtectedFields = false;

      // check if the object grants the current user access based on the extracted fields
      protectedFieldsPointerPerm.forEach(pointerPerm => {
        let pointerPermIncludesUser = false;
        const readUserFieldValue = object[pointerPerm.key];
        if (readUserFieldValue) {
          if (Array.isArray(readUserFieldValue)) {
            pointerPermIncludesUser = readUserFieldValue.some(user => user.objectId && user.objectId === userId);
          } else {
            pointerPermIncludesUser = readUserFieldValue.objectId && readUserFieldValue.objectId === userId;
          }
        }
        if (pointerPermIncludesUser) {
          overrideProtectedFields = true;
          newProtectedFields.push(pointerPerm.value);
        }
      });

      // if at least one pointer-permission affected the current user
      // intersect vs protectedFields from previous stage (@see addProtectedFields)
      // Sets theory (intersections): A x (B x C) == (A x B) x C
      if (overrideProtectedFields && protectedFields) {
        newProtectedFields.push(protectedFields);
      }
      // intersect all sets of protectedFields
      newProtectedFields.forEach(fields => {
        if (fields) {
          // if there're no protctedFields by other criteria ( id / role / auth)
          // then we must intersect each set (per userField)
          if (!protectedFields) {
            protectedFields = fields;
          } else {
            protectedFields = protectedFields.filter(v => fields.includes(v));
          }
        }
      });
    }
  }
  const isUserClass = className === '_User';
  if (isUserClass) {
    object.password = object._hashed_password;
    delete object._hashed_password;
    delete object.sessionToken;
  }
  if (isMaintenance) {
    return object;
  }

  /* special treat for the user class: don't filter protectedFields if currently loggedin user is
  the retrieved user, unless protectedFieldsOwnerExempt is false */
  const isOwnerExempt = protectedFieldsOwnerExempt !== false && isUserClass && userId && object.objectId === userId;
  if (!isOwnerExempt) {
    protectedFields && protectedFields.forEach(k => delete object[k]);

    // fields not requested by client (excluded),
    // but were needed to apply protectedFields
    perms?.protectedFields?.temporaryKeys?.forEach(k => delete object[k]);
  }
  for (const key in object) {
    if (key.charAt(0) === '_') {
      delete object[key];
    }
  }
  if (!isUserClass || isMaster) {
    return object;
  }
  if (aclGroup.indexOf(object.objectId) > -1) {
    return object;
  }
  delete object.authData;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
const specialKeysForUpdate = Object.keys(internalFields).filter(k => internalFields[k].masterWrite);
const isSpecialUpdateKey = key => {
  return specialKeysForUpdate.indexOf(key) >= 0;
};
function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}
const flattenUpdateOperatorsForCreate = object => {
  for (const key in object) {
    if (object[key] && object[key].__op) {
      switch (object[key].__op) {
        case 'Increment':
          if (typeof object[key].amount !== 'number') {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].amount;
          break;
        case 'SetOnInsert':
          object[key] = object[key].amount;
          break;
        case 'Add':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].objects;
          break;
        case 'AddUnique':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = object[key].objects;
          break;
        case 'Remove':
          if (!Array.isArray(object[key].objects)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }
          object[key] = [];
          break;
        case 'Delete':
          delete object[key];
          break;
        default:
          throw new _node.Parse.Error(_node.Parse.Error.COMMAND_UNAVAILABLE, `The ${object[key].__op} operator is not supported yet.`);
      }
    }
  }
};
const transformAuthData = (className, object, schema) => {
  if (object.authData && className === '_User') {
    Object.keys(object.authData).forEach(provider => {
      const providerData = object.authData[provider];
      const fieldName = `_auth_data_${provider}`;
      if (providerData == null) {
        object[fieldName] = {
          __op: 'Delete'
        };
      } else {
        object[fieldName] = providerData;
        schema.fields[fieldName] = {
          type: 'Object'
        };
      }
    });
    delete object.authData;
  }
};
// Transforms a Database format ACL to a REST API format ACL
const untransformObjectACL = ({
  _rperm,
  _wperm,
  ...output
}) => {
  if (_rperm || _wperm) {
    output.ACL = {};

    // Own-property check so an inherited member name is never read as the container
    (_rperm || []).forEach(entry => {
      if (!Object.hasOwn(output.ACL, entry)) {
        output.ACL[entry] = {
          read: true
        };
      } else {
        output.ACL[entry]['read'] = true;
      }
    });
    (_wperm || []).forEach(entry => {
      if (!Object.hasOwn(output.ACL, entry)) {
        output.ACL[entry] = {
          write: true
        };
      } else {
        output.ACL[entry]['write'] = true;
      }
    });
  }
  return output;
};

/**
 * When querying, the fieldName may be compound, extract the root fieldName
 *     `temperature.celsius` becomes `temperature`
 * @param {string} fieldName that may be a compound field name
 * @returns {string} the root name of the field
 */
const getRootFieldName = fieldName => {
  return fieldName.split('.')[0];
};
const relationSchema = {
  fields: {
    relatedId: {
      type: 'String'
    },
    owningId: {
      type: 'String'
    }
  }
};
const convertEmailToLowercase = (object, className, options) => {
  if (className === '_User' && options.convertEmailToLowercase) {
    if (typeof object['email'] === 'string') {
      object['email'] = object['email'].toLowerCase();
    }
  }
};
const convertUsernameToLowercase = (object, className, options) => {
  if (className === '_User' && options.convertUsernameToLowercase) {
    if (typeof object['username'] === 'string') {
      object['username'] = object['username'].toLowerCase();
    }
  }
};
class DatabaseController {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.options = options || {};
    this.idempotencyOptions = this.options.idempotencyOptions || {};
    // Prevent mutable this.schema, otherwise one request could use
    // multiple schemas, so instead use loadSchema to get a schema.
    this.schemaPromise = null;
    this._transactionalSession = null;
    this._transactionalSessionPending = false;
    this.options = options;
  }
  collectionExists(className) {
    return this.adapter.classExists(className);
  }
  purgeCollection(className) {
    return this.loadSchema().then(schemaController => schemaController.getOneSchema(className)).then(schema => this.adapter.deleteObjectsByQuery(className, schema, {}));
  }
  validateClassName(className) {
    if (!SchemaController.classNameIsValid(className)) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_CLASS_NAME, 'invalid className: ' + className));
    }
    return Promise.resolve();
  }

  // Returns a promise for a schemaController.
  loadSchema(options = {
    clearCache: false
  }) {
    if (this.schemaPromise != null) {
      return this.schemaPromise;
    }
    this.schemaPromise = SchemaController.load(this.adapter, options);
    this.schemaPromise.then(() => delete this.schemaPromise, () => delete this.schemaPromise);
    return this.loadSchema(options);
  }
  loadSchemaIfNeeded(schemaController, options = {
    clearCache: false
  }) {
    return schemaController ? Promise.resolve(schemaController) : this.loadSchema(options);
  }

  // Returns a promise for the classname that is related to the given
  // classname through the key.
  // TODO: make this not in the DatabaseController interface
  redirectClassNameForKey(className, key) {
    return this.loadSchema().then(schema => {
      var t = schema.getExpectedType(className, key);
      if (t != null && typeof t !== 'string' && t.type === 'Relation') {
        return t.targetClass;
      }
      return className;
    });
  }

  // Uses the schema to validate the object (REST API format).
  // Returns a promise that resolves to the new schema.
  // This does not update this.schema, because in a situation like a
  // batch request, that could confuse other users of the schema.
  validateObject(className, object, query, runOptions, maintenance) {
    let schema;
    const acl = runOptions.acl;
    const isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(s => {
      schema = s;
      if (isMaster) {
        return Promise.resolve();
      }
      return this.canAddField(schema, className, object, aclGroup, runOptions);
    }).then(() => {
      return schema.validateObject(className, object, query, maintenance);
    });
  }

  /**
   * Updates objects in the database that match the given query.
   * @param {Object} options
   * @param {boolean} [options.many=false] When true, updates all matching documents
   *   and returns `{ matchedCount, modifiedCount }` where values are numbers if the
   *   storage adapter supports `UpdateManyResult`, or `undefined` otherwise.
   */
  update(className, query, update, {
    acl,
    many,
    upsert,
    addsField
  } = {}, skipSanitization = false, validateOnly = false, validSchemaController) {
    try {
      _Utils.default.checkProhibitedKeywords(this.options, update);
    } catch (error) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `${error}`));
    }
    try {
      const {
        validateFileUrlsInObject
      } = require('../FileUrlValidator');
      validateFileUrlsInObject(update, this.options);
    } catch (error) {
      return Promise.reject(error instanceof _node.Parse.Error ? error : new _node.Parse.Error(_node.Parse.Error.FILE_SAVE_ERROR, error.message || error));
    }
    const originalQuery = query;
    const originalUpdate = update;
    // Make a copy of the object, so we don't mutate the incoming data.
    update = structuredClone(update);
    var relationUpdates = [];
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'update')).then(() => {
        relationUpdates = this.collectRelationUpdates(className, originalQuery.objectId, update);
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'update', query, aclGroup);
          if (addsField) {
            query = {
              $and: [query, this.addPointerPermissions(schemaController, className, 'addField', query, aclGroup)]
            };
          }
        }
        if (!query) {
          return Promise.resolve();
        }
        if (acl) {
          query = addWriteACL(query, acl);
        }
        validateQuery(query, isMaster, false, true, this.options);
        return schemaController.getOneSchema(className, true).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }
          throw error;
        }).then(schema => {
          Object.keys(update).forEach(fieldName => {
            if (fieldName.match(/^authData\./)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
            const rootFieldName = getRootFieldName(fieldName);
            if (!SchemaController.fieldNameIsValid(rootFieldName, className) && !isSpecialUpdateKey(rootFieldName)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
          });
          for (const updateOperation in update) {
            if (update[updateOperation] && typeof update[updateOperation] === 'object' && Object.keys(update[updateOperation]).some(innerKey => innerKey.includes('$') || innerKey.includes('.'))) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
            }
          }
          update = transformObjectACL(update);
          convertEmailToLowercase(update, className, this.options);
          convertUsernameToLowercase(update, className, this.options);
          transformAuthData(className, update, schema);
          if (validateOnly) {
            return this.adapter.find(className, schema, query, {
              readPreference: 'primary'
            }).then(result => {
              if (!result || !result.length) {
                throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
              }
              return {};
            });
          }
          if (many) {
            return this.adapter.updateObjectsByQuery(className, schema, query, update, this._transactionalSession);
          } else if (upsert) {
            return this.adapter.upsertOneObject(className, schema, query, update, this._transactionalSession);
          } else {
            return this.adapter.findOneAndUpdate(className, schema, query, update, this._transactionalSession);
          }
        });
      }).then(result => {
        if (!result) {
          throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }
        if (validateOnly) {
          return result;
        }
        return this.handleRelationUpdates(className, originalQuery.objectId, update, relationUpdates).then(() => {
          return result;
        });
      }).then(result => {
        if (skipSanitization) {
          return Promise.resolve(result);
        }
        if (many) {
          return {
            matchedCount: typeof result?.matchedCount === 'number' ? result.matchedCount : undefined,
            modifiedCount: typeof result?.modifiedCount === 'number' ? result.modifiedCount : undefined
          };
        }
        return this._sanitizeDatabaseResult(originalUpdate, result);
      });
    });
  }

  // Collect all relation-updating operations from a REST-format update.
  // Returns a list of all relation updates to perform
  // This mutates update.
  collectRelationUpdates(className, objectId, update) {
    var ops = [];
    var deleteMe = [];
    objectId = update.objectId || objectId;
    var process = (op, key) => {
      if (!op) {
        return;
      }
      if (op.__op == 'AddRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }
      if (op.__op == 'RemoveRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }
      if (op.__op == 'Batch') {
        for (var x of op.ops) {
          process(x, key);
        }
      }
    };
    for (const key in update) {
      process(update[key], key);
    }
    for (const key of deleteMe) {
      delete update[key];
    }
    return ops;
  }

  // Processes relation-updating operations from a REST-format update.
  // Returns a promise that resolves when all updates have been performed
  handleRelationUpdates(className, objectId, update, ops) {
    var pending = [];
    objectId = update.objectId || objectId;
    ops.forEach(({
      key,
      op
    }) => {
      if (!op) {
        return;
      }
      if (op.__op == 'AddRelation') {
        for (const object of op.objects) {
          pending.push(this.addRelation(key, className, objectId, object.objectId));
        }
      }
      if (op.__op == 'RemoveRelation') {
        for (const object of op.objects) {
          pending.push(this.removeRelation(key, className, objectId, object.objectId));
        }
      }
    });
    return Promise.all(pending);
  }

  // Adds a relation.
  // Returns a promise that resolves successfully iff the add was successful.
  addRelation(key, fromClassName, fromId, toId) {
    const doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.upsertOneObject(`_Join:${key}:${fromClassName}`, relationSchema, doc, doc, this._transactionalSession);
  }

  // Removes a relation.
  // Returns a promise that resolves successfully iff the remove was
  // successful.
  removeRelation(key, fromClassName, fromId, toId) {
    var doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.deleteObjectsByQuery(`_Join:${key}:${fromClassName}`, relationSchema, doc, this._transactionalSession).catch(error => {
      // We don't care if they try to delete a non-existent relation.
      if (error.code == _node.Parse.Error.OBJECT_NOT_FOUND) {
        return;
      }
      throw error;
    });
  }

  // Removes objects matches this query from the database.
  // Returns a promise that resolves successfully iff the object was
  // deleted.
  // Options:
  //   acl:  a list of strings. If the object to be updated has an ACL,
  //         one of the provided strings must provide the caller with
  //         write permissions.
  destroy(className, query, {
    acl
  } = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'delete')).then(() => {
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'delete', query, aclGroup);
          if (!query) {
            throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
          }
        }
        // delete by query
        if (acl) {
          query = addWriteACL(query, acl);
        }
        validateQuery(query, isMaster, false, false, this.options);
        return schemaController.getOneSchema(className).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }
          throw error;
        }).then(parseFormatSchema => this.adapter.deleteObjectsByQuery(className, parseFormatSchema, query, this._transactionalSession)).catch(error => {
          // When deleting sessions while changing passwords, don't throw an error if they don't have any sessions.
          if (className === '_Session' && error.code === _node.Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve({});
          }
          throw error;
        });
      });
    });
  }

  // Inserts an object into the database.
  // Returns a promise that resolves successfully iff the object saved.
  create(className, object, {
    acl
  } = {}, validateOnly = false, validSchemaController) {
    try {
      _Utils.default.checkProhibitedKeywords(this.options, object);
    } catch (error) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `${error}`));
    }
    try {
      const {
        validateFileUrlsInObject
      } = require('../FileUrlValidator');
      validateFileUrlsInObject(object, this.options);
    } catch (error) {
      return Promise.reject(error instanceof _node.Parse.Error ? error : new _node.Parse.Error(_node.Parse.Error.FILE_SAVE_ERROR, error.message || error));
    }
    // Make a copy of the object, so we don't mutate the incoming data.
    const originalObject = object;
    object = transformObjectACL(object);
    convertEmailToLowercase(object, className, this.options);
    convertUsernameToLowercase(object, className, this.options);
    object.createdAt = {
      iso: object.createdAt,
      __type: 'Date'
    };
    object.updatedAt = {
      iso: object.updatedAt,
      __type: 'Date'
    };
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    const relationUpdates = this.collectRelationUpdates(className, null, object);
    return this.validateClassName(className).then(() => this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'create')).then(() => schemaController.enforceClassExists(className)).then(() => schemaController.getOneSchema(className, true)).then(schema => {
        transformAuthData(className, object, schema);
        flattenUpdateOperatorsForCreate(object);
        if (validateOnly) {
          return {};
        }
        return this.adapter.createObject(className, SchemaController.convertSchemaToAdapterSchema(schema), object, this._transactionalSession);
      }).then(result => {
        if (validateOnly) {
          return originalObject;
        }
        return this.handleRelationUpdates(className, object.objectId, object, relationUpdates).then(() => {
          return this._sanitizeDatabaseResult(originalObject, result.ops[0]);
        });
      });
    });
  }
  canAddField(schema, className, object, aclGroup, runOptions) {
    const classSchema = schema.schemaData[className];
    if (!classSchema) {
      return Promise.resolve();
    }
    const fields = Object.keys(object);
    const schemaFields = Object.keys(classSchema.fields);
    const newKeys = fields.filter(field => {
      // Skip fields that are unset
      if (object[field] && object[field].__op && object[field].__op === 'Delete') {
        return false;
      }
      return schemaFields.indexOf(getRootFieldName(field)) < 0;
    });
    if (newKeys.length > 0) {
      // adds a marker that new field is being adding during update
      runOptions.addsField = true;
      const action = runOptions.action;
      return schema.validatePermission(className, aclGroup, 'addField', action);
    }
    return Promise.resolve();
  }

  // Won't delete collections in the system namespace
  /**
   * Delete all classes and clears the schema cache
   *
   * @param {boolean} fast set to true if it's ok to just delete rows and not indexes
   * @returns {Promise<void>} when the deletions completes
   */
  deleteEverything(fast = false) {
    this.schemaPromise = null;
    _SchemaCache.default.clear();
    return this.adapter.deleteAllClasses(fast);
  }

  // Returns a promise for a list of related ids given an owning id.
  // className here is the owning className.
  relatedIds(className, key, owningId, queryOptions) {
    const {
      skip,
      limit,
      sort
    } = queryOptions;
    const findOptions = {};
    if (sort && sort.createdAt && this.adapter.canSortOnJoinTables) {
      findOptions.sort = {
        _id: sort.createdAt
      };
      findOptions.limit = limit;
      findOptions.skip = skip;
      queryOptions.skip = 0;
    }
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      owningId
    }, findOptions).then(results => results.map(result => result.relatedId));
  }

  // Returns a promise for a list of owning ids given some related ids.
  // className here is the owning className.
  owningIds(className, key, relatedIds) {
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      relatedId: {
        $in: relatedIds
      }
    }, {
      keys: ['owningId']
    }).then(results => results.map(result => result.owningId));
  }

  // Modifies query so that it no longer has $in on relation fields, or
  // equal-to-pointer constraints on relation fields.
  // Returns a promise that resolves when query is mutated
  reduceInRelation(className, query, schema) {
    // Search for an in-relation or equal-to-relation
    // Make it sequential for now, not sure of paralleization side effects
    const promises = [];
    if (query['$or']) {
      const ors = query['$or'];
      promises.push(...ors.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$or'][index] = aQuery;
        });
      }));
    }
    if (query['$and']) {
      const ands = query['$and'];
      promises.push(...ands.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$and'][index] = aQuery;
        });
      }));
    }
    const otherKeys = Object.keys(query).map(key => {
      if (key === '$and' || key === '$or') {
        return;
      }
      const t = schema.getExpectedType(className, key);
      if (!t || t.type !== 'Relation') {
        return Promise.resolve(query);
      }
      let queries = null;
      if (query[key] && (query[key]['$in'] || query[key]['$ne'] || query[key]['$nin'] || query[key].__type == 'Pointer')) {
        // Build the list of queries
        queries = Object.keys(query[key]).map(constraintKey => {
          let relatedIds;
          let isNegation = false;
          if (constraintKey === 'objectId') {
            relatedIds = [query[key].objectId];
          } else if (constraintKey == '$in') {
            relatedIds = query[key]['$in'].map(r => r.objectId);
          } else if (constraintKey == '$nin') {
            isNegation = true;
            relatedIds = query[key]['$nin'].map(r => r.objectId);
          } else if (constraintKey == '$ne') {
            isNegation = true;
            relatedIds = [query[key]['$ne'].objectId];
          } else {
            return;
          }
          return {
            isNegation,
            relatedIds
          };
        });
      } else {
        queries = [{
          isNegation: false,
          relatedIds: []
        }];
      }

      // remove the current queryKey as we don,t need it anymore
      delete query[key];
      // execute each query independently to build the list of
      // $in / $nin
      const promises = queries.map(q => {
        if (!q) {
          return Promise.resolve();
        }
        return this.owningIds(className, key, q.relatedIds).then(ids => {
          if (q.isNegation) {
            this.addNotInObjectIdsIds(ids, query);
          } else {
            this.addInObjectIdsIds(ids, query);
          }
          return Promise.resolve();
        });
      });
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      });
    });
    return Promise.all([...promises, ...otherKeys]).then(() => {
      return Promise.resolve(query);
    });
  }

  // Modifies query so that it no longer has $relatedTo
  // Returns a promise that resolves when query is mutated
  reduceRelationKeys(className, query, queryOptions, auth = {}, aclGroup = [], isMaster = false, schemaController) {
    if (query['$or']) {
      return Promise.all(query['$or'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    if (query['$and']) {
      return Promise.all(query['$and'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    if (Array.isArray(query['$nor'])) {
      // Guard with Array.isArray (unlike the legacy $or/$and checks above) so a
      // malformed non-array $nor still falls through to validateQuery and yields
      // the existing INVALID_QUERY error instead of throwing here.
      return Promise.all(query['$nor'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions, auth, aclGroup, isMaster, schemaController);
      }));
    }
    var relatedTo = query['$relatedTo'];
    if (relatedTo) {
      // The owning reference and relation key must be well-formed strings. A
      // non-string objectId (e.g. a query operator such as `{$gt: ''}`) would
      // pass `authorizeRelatedToQuery` existentially against any readable owner
      // while `relatedIds` applies the operator across every owner, disclosing
      // relation membership of owning objects the caller cannot read.
      const relatedToObject = relatedTo.object;
      if (!relatedToObject || typeof relatedToObject.className !== 'string' || typeof relatedToObject.objectId !== 'string' || typeof relatedTo.key !== 'string') {
        throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Invalid $relatedTo constraint.');
      }
      return this.authorizeRelatedToQuery(relatedTo, auth, aclGroup, isMaster, schemaController).then(canReadOwningObject => {
        delete query['$relatedTo'];
        if (!canReadOwningObject) {
          // The caller is not allowed to read the owning object, so the
          // relation must not disclose any linked objects (and must not act
          // as a membership oracle for a known related id).
          this.addInObjectIdsIds([], query);
          return this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController);
        }
        return this.relatedIds(relatedTo.object.className, relatedTo.key, relatedTo.object.objectId, queryOptions).then(ids => {
          this.addInObjectIdsIds(ids, query);
          return this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController);
        });
      }).then(() => {});
    }
  }

  // Authorizes a `$relatedTo` relation query against the owning object before
  // its join table is read by `relatedIds`. Without this check, `$relatedTo`
  // bypasses both `protectedFields` and the owning object's ACL/CLP, because
  // the downstream protected-field and ACL filters only apply to the queried
  // (target) class, never to the owning class referenced by `$relatedTo`.
  //
  // - Throws `OPERATION_FORBIDDEN` if the relation key is a protected field on
  //   the owning class for the caller's auth context (mirrors the protected
  //   WHERE-field denial in `RestQuery.denyProtectedFields`).
  // - Resolves to `true` if the caller may read the owning object (so the join
  //   table read may proceed), or `false` otherwise (so the relation yields no
  //   results and cannot be used as a membership oracle).
  //
  // Master and maintenance requests bypass both checks by design.
  authorizeRelatedToQuery(relatedTo, auth = {}, aclGroup = [], isMaster = false, schemaController) {
    if (isMaster) {
      return Promise.resolve(true);
    }
    const owningClassName = relatedTo && relatedTo.object && relatedTo.object.className;
    const owningId = relatedTo && relatedTo.object && relatedTo.object.objectId;
    const relationKey = relatedTo && relatedTo.key;
    return this.loadSchemaIfNeeded(schemaController).then(loadedSchema => {
      // 1. The relation key must not be a protected field on the owning class.
      const protectedFields = this.addProtectedFields(loadedSchema, owningClassName, {}, aclGroup, auth) || [];
      const rootField = typeof relationKey === 'string' ? relationKey.split('.')[0] : relationKey;
      if (protectedFields.includes(relationKey) || protectedFields.includes(rootField)) {
        throw (0, _Error.createSanitizedError)(_node.Parse.Error.OPERATION_FORBIDDEN, `This user is not allowed to query ${relationKey} on class ${owningClassName}`, this.options);
      }
      // 2. The caller must be able to read the owning object itself. A read with
      //    the caller's auth context applies the owning class CLP, the object
      //    ACL and pointer permissions. Any "not authorized" or "not found"
      //    outcome maps to "cannot read", so the relation returns no results.
      return this.find(owningClassName, {
        objectId: owningId
      }, {
        acl: aclGroup,
        limit: 1,
        keys: ['objectId'],
        op: 'get'
      }, auth, loadedSchema).then(results => Array.isArray(results) && results.length > 0).catch(error => {
        if (error instanceof _node.Parse.Error && (error.code === _node.Parse.Error.OPERATION_FORBIDDEN || error.code === _node.Parse.Error.OBJECT_NOT_FOUND)) {
          return false;
        }
        throw error;
      });
    });
  }
  addInObjectIdsIds(ids = null, query) {
    const idsFromString = typeof query.objectId === 'string' ? [query.objectId] : null;
    const idsFromEq = query.objectId && query.objectId['$eq'] ? [query.objectId['$eq']] : null;
    const idsFromIn = query.objectId && query.objectId['$in'] ? query.objectId['$in'] : null;

    // -disable-next
    const allIds = [idsFromString, idsFromEq, idsFromIn, ids].filter(list => list !== null);
    const totalLength = allIds.reduce((memo, list) => memo + list.length, 0);
    let idsIntersection = [];
    if (totalLength > 125) {
      idsIntersection = _intersect.default.big(allIds);
    } else {
      idsIntersection = (0, _intersect.default)(allIds);
    }

    // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.
    if (!('objectId' in query)) {
      query.objectId = {
        $in: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $in: undefined,
        $eq: query.objectId
      };
    }
    query.objectId['$in'] = idsIntersection;
    return query;
  }
  addNotInObjectIdsIds(ids = [], query) {
    const idsFromNin = query.objectId && query.objectId['$nin'] ? query.objectId['$nin'] : [];
    let allIds = [...idsFromNin, ...ids].filter(list => list !== null);

    // make a set and spread to remove duplicates
    allIds = [...new Set(allIds)];

    // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.
    if (!('objectId' in query)) {
      query.objectId = {
        $nin: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $nin: undefined,
        $eq: query.objectId
      };
    }
    query.objectId['$nin'] = allIds;
    return query;
  }

  // Runs a query on the database.
  // Returns a promise that resolves to a list of items.
  // Options:
  //   skip    number of results to skip.
  //   limit   limit to this number of results.
  //   sort    an object where keys are the fields to sort by.
  //           the value is +1 for ascending, -1 for descending.
  //   count   run a count instead of returning results.
  //   acl     restrict this operation with an ACL for the provided array
  //           of user objectIds and roles. acl: null means no user.
  //           when this field is not present, don't do anything regarding ACLs.
  //  caseInsensitive make string comparisons case insensitive
  // TODO: make userIds not needed here. The db adapter shouldn't know
  // anything about users, ideally. Then, improve the format of the ACL
  // arg to work like the others.
  find(className, query, {
    skip,
    limit,
    acl,
    sort = {},
    count,
    keys,
    op,
    distinct,
    pipeline,
    readPreference,
    hint,
    caseInsensitive = false,
    explain,
    comment,
    rawValues,
    rawFieldNames
  } = {}, auth = {}, validSchemaController) {
    const isMaintenance = auth.isMaintenance;
    const isMaster = acl === undefined || isMaintenance;
    const aclGroup = acl || [];
    op = op || (typeof query.objectId == 'string' && Object.keys(query).length === 1 ? 'get' : 'find');
    // Count operation if counting
    op = count === true ? 'count' : op;
    let classExists = true;
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      //Allow volatile classes if querying with Master (for _PushStatus)
      //TODO: Move volatile classes concept into mongo adapter, postgres adapter shouldn't care
      //that api.parse.com breaks when _PushStatus exists in mongo.
      return schemaController.getOneSchema(className, isMaster).catch(error => {
        // Behavior for non-existent classes is kinda weird on Parse.com. Probably doesn't matter too much.
        // For now, pretend the class exists but has no objects,
        if (error === undefined) {
          classExists = false;
          return {
            fields: {}
          };
        }
        throw error;
      }).then(schema => {
        // Parse.com treats queries on _created_at and _updated_at as if they were queries on createdAt and updatedAt,
        // so duplicate that behavior here. If both are specified, the correct behavior to match Parse.com is to
        // use the one that appears first in the sort list.
        if (sort._created_at) {
          sort.createdAt = sort._created_at;
          delete sort._created_at;
        }
        if (sort._updated_at) {
          sort.updatedAt = sort._updated_at;
          delete sort._updated_at;
        }
        const queryOptions = {
          skip,
          limit,
          sort,
          keys,
          readPreference,
          hint,
          caseInsensitive: this.options.enableCollationCaseComparison ? false : caseInsensitive,
          explain,
          comment
        };
        Object.keys(sort).forEach(fieldName => {
          if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Cannot sort by ${fieldName}`);
          }
          const rootFieldName = getRootFieldName(fieldName);
          if (!SchemaController.fieldNameIsValid(rootFieldName, className)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
          }
          if (!schema.fields[fieldName.split('.')[0]] && fieldName !== 'score') {
            delete sort[fieldName];
          }
        });
        return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, op)).then(() => this.reduceRelationKeys(className, query, queryOptions, auth, aclGroup, isMaster, schemaController)).then(() => this.reduceInRelation(className, query, schemaController)).then(() => {
          let protectedFields;
          if (!isMaster) {
            query = this.addPointerPermissions(schemaController, className, op, query, aclGroup);
            /* Don't use projections to optimize the protectedFields since the protectedFields
              based on pointer-permissions are determined after querying. The filtering can
              overwrite the protected fields. */
            protectedFields = this.addProtectedFields(schemaController, className, query, aclGroup, auth, queryOptions);
          }
          if (!query) {
            if (op === 'get') {
              throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
            } else {
              return [];
            }
          }
          if (!isMaster) {
            if (op === 'update' || op === 'delete') {
              query = addWriteACL(query, aclGroup);
            } else {
              query = addReadACL(query, aclGroup);
            }
          }
          validateQuery(query, isMaster, isMaintenance, false, this.options);
          if (count) {
            if (!classExists) {
              return 0;
            } else {
              return this.adapter.count(className, schema, query, readPreference, undefined, hint, comment);
            }
          } else if (distinct) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.distinct(className, schema, query, distinct);
            }
          } else if (pipeline) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.aggregate(className, schema, pipeline, readPreference, hint, explain, comment, rawValues, rawFieldNames);
            }
          } else if (explain) {
            return this.adapter.find(className, schema, query, queryOptions);
          } else {
            return this.adapter.find(className, schema, query, queryOptions).then(objects => objects.map(object => {
              object = untransformObjectACL(object);
              return filterSensitiveData(isMaster, isMaintenance, aclGroup, auth, op, schemaController, className, protectedFields, object, this.options.protectedFieldsOwnerExempt);
            })).catch(error => {
              if (error instanceof _node.Parse.Error) {
                throw error;
              }
              const detailedMessage = typeof error === 'string' ? error : error?.message || 'An internal server error occurred';
              throw (0, _Error.createSanitizedError)(_node.Parse.Error.INTERNAL_SERVER_ERROR, detailedMessage, this.options, 'An internal server error occurred');
            });
          }
        });
      });
    });
  }
  deleteSchema(className) {
    let schemaController;
    return this.loadSchema({
      clearCache: true
    }).then(s => {
      schemaController = s;
      return schemaController.getOneSchema(className, true);
    }).catch(error => {
      if (error === undefined) {
        return {
          fields: {}
        };
      } else {
        throw error;
      }
    }).then(schema => {
      return this.collectionExists(className).then(() => this.adapter.count(className, {
        fields: {}
      }, null, '', false)).then(count => {
        if (count > 0) {
          throw new _node.Parse.Error(255, `Class ${className} is not empty, contains ${count} objects, cannot drop schema.`);
        }
        return this.adapter.deleteClass(className);
      }).then(wasParseCollection => {
        if (wasParseCollection) {
          const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
          return Promise.all(relationFieldNames.map(name => this.adapter.deleteClass(joinTableName(className, name)))).then(() => {
            _SchemaCache.default.del(className);
            return schemaController.reloadData();
          });
        } else {
          return Promise.resolve();
        }
      });
    });
  }

  // This helps to create intermediate objects for simpler comparison of
  // key value pairs used in query objects. Each key value pair will represented
  // in a similar way to json
  objectToEntriesStrings(query) {
    return Object.entries(query).map(a => a.map(s => JSON.stringify(s)).join(':'));
  }

  // Naive logic reducer for OR operations meant to be used only for pointer permissions.
  reduceOrOperation(query) {
    if (!query.$or) {
      return query;
    }
    const queries = query.$or.map(q => this.objectToEntriesStrings(q));
    let repeat = false;
    do {
      repeat = false;
      for (let i = 0; i < queries.length - 1; i++) {
        for (let j = i + 1; j < queries.length; j++) {
          const [shorter, longer] = queries[i].length > queries[j].length ? [j, i] : [i, j];
          const foundEntries = queries[shorter].reduce((acc, entry) => acc + (queries[longer].includes(entry) ? 1 : 0), 0);
          const shorterEntries = queries[shorter].length;
          if (foundEntries === shorterEntries) {
            // If the shorter query is completely contained in the longer one, we can strike
            // out the longer query.
            query.$or.splice(longer, 1);
            queries.splice(longer, 1);
            repeat = true;
            break;
          }
        }
      }
    } while (repeat);
    if (query.$or.length === 1) {
      query = {
        ...query,
        ...query.$or[0]
      };
      delete query.$or;
    }
    return query;
  }

  // Naive logic reducer for AND operations meant to be used only for pointer permissions.
  reduceAndOperation(query) {
    if (!query.$and) {
      return query;
    }
    const queries = query.$and.map(q => this.objectToEntriesStrings(q));
    let repeat = false;
    do {
      repeat = false;
      for (let i = 0; i < queries.length - 1; i++) {
        for (let j = i + 1; j < queries.length; j++) {
          const [shorter, longer] = queries[i].length > queries[j].length ? [j, i] : [i, j];
          const foundEntries = queries[shorter].reduce((acc, entry) => acc + (queries[longer].includes(entry) ? 1 : 0), 0);
          const shorterEntries = queries[shorter].length;
          if (foundEntries === shorterEntries) {
            // If the shorter query is completely contained in the longer one, we can strike
            // out the shorter query.
            query.$and.splice(shorter, 1);
            queries.splice(shorter, 1);
            repeat = true;
            break;
          }
        }
      }
    } while (repeat);
    if (query.$and.length === 1) {
      query = {
        ...query,
        ...query.$and[0]
      };
      delete query.$and;
    }
    return query;
  }

  // Constraints query using CLP's pointer permissions (PP) if any.
  // 1. Etract the user id from caller's ACLgroup;
  // 2. Exctract a list of field names that are PP for target collection and operation;
  // 3. Constraint the original query so that each PP field must
  // point to caller's id (or contain it in case of PP field being an array)
  addPointerPermissions(schema, className, operation, query, aclGroup = []) {
    // Check if class has public permission for operation
    // If the BaseCLP pass, let go through
    if (schema.testPermissionsForClassName(className, aclGroup, operation)) {
      return query;
    }
    const perms = schema.getClassLevelPermissions(className);
    const userACL = aclGroup.filter(acl => {
      return acl.indexOf('role:') != 0 && acl != '*';
    });
    const groupKey = ['get', 'find', 'count'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const permFields = [];
    if (perms[operation] && perms[operation].pointerFields) {
      permFields.push(...perms[operation].pointerFields);
    }
    if (perms[groupKey]) {
      for (const field of perms[groupKey]) {
        if (!permFields.includes(field)) {
          permFields.push(field);
        }
      }
    }
    // the ACL should have exactly 1 user
    if (permFields.length > 0) {
      // the ACL should have exactly 1 user
      // No user set return undefined
      // If the length is > 1, that means we didn't de-dupe users correctly
      if (userACL.length != 1) {
        return;
      }
      const userId = userACL[0];
      const userPointer = {
        __type: 'Pointer',
        className: '_User',
        objectId: userId
      };
      const queries = permFields.map(key => {
        const fieldDescriptor = schema.getExpectedType(className, key);
        const fieldType = fieldDescriptor && typeof fieldDescriptor === 'object' && Object.prototype.hasOwnProperty.call(fieldDescriptor, 'type') ? fieldDescriptor.type : null;
        let queryClause;
        if (fieldType === 'Pointer') {
          // constraint for single pointer setup
          queryClause = {
            [key]: userPointer
          };
        } else if (fieldType === 'Array') {
          // constraint for users-array setup
          queryClause = {
            [key]: {
              $all: [userPointer]
            }
          };
        } else if (fieldType === 'Object') {
          // constraint for object setup
          queryClause = {
            [key]: userPointer
          };
        } else {
          // This means that there is a CLP field of an unexpected type. This condition should not happen, which is
          // why is being treated as an error.
          throw Error(`An unexpected condition occurred when resolving pointer permissions: ${className} ${key}`);
        }
        // if we already have a constraint on the key, use the $and
        if (Object.prototype.hasOwnProperty.call(query, key)) {
          return this.reduceAndOperation({
            $and: [queryClause, query]
          });
        }
        // otherwise just add the constaint
        return Object.assign({}, query, queryClause);
      });
      return queries.length === 1 ? queries[0] : this.reduceOrOperation({
        $or: queries
      });
    } else {
      return query;
    }
  }
  addProtectedFields(schema, className, query = {}, aclGroup = [], auth = {}, queryOptions = {}) {
    const perms = schema && schema.getClassLevelPermissions ? schema.getClassLevelPermissions(className) : schema;
    if (!perms) {
      return null;
    }
    const protectedFields = perms.protectedFields;
    if (!protectedFields) {
      return null;
    }
    if (className === '_User' && this.options.protectedFieldsOwnerExempt !== false && aclGroup.indexOf(query.objectId) > -1) {
      return null;
    }

    // for queries where "keys" are set and do not include all 'userField':{field},
    // we have to transparently include it, and then remove before returning to client
    // Because if such key not projected the permission won't be enforced properly
    // PS this is called when 'excludeKeys' already reduced to 'keys'
    const preserveKeys = queryOptions.keys;

    // these are keys that need to be included only
    // to be able to apply protectedFields by pointer
    // and then unset before returning to client (later in  filterSensitiveFields)
    const serverOnlyKeys = [];
    const authenticated = auth.user;

    // map to allow check without array search
    const roles = (auth.userRoles || []).reduce((acc, r) => {
      acc[r] = protectedFields[r];
      return acc;
    }, {});

    // array of sets of protected fields. separate item for each applicable criteria
    const protectedKeysSets = [];
    for (const key in protectedFields) {
      // skip userFields
      if (key.startsWith('userField:')) {
        if (preserveKeys) {
          const fieldName = key.substring(10);
          if (!preserveKeys.includes(fieldName)) {
            // 1. put it there temporarily
            queryOptions.keys && queryOptions.keys.push(fieldName);
            // 2. preserve it delete later
            serverOnlyKeys.push(fieldName);
          }
        }
        continue;
      }

      // add public tier
      if (key === '*') {
        protectedKeysSets.push(protectedFields[key]);
        continue;
      }
      if (authenticated) {
        if (key === 'authenticated') {
          // for logged in users
          protectedKeysSets.push(protectedFields[key]);
          continue;
        }
        if (roles[key] && key.startsWith('role:')) {
          // add applicable roles
          protectedKeysSets.push(roles[key]);
        }
      }
    }

    // check if there's a rule for current user's id
    if (authenticated) {
      const userId = auth.user.id;
      if (perms.protectedFields[userId]) {
        protectedKeysSets.push(perms.protectedFields[userId]);
      }
    }

    // preserve fields to be removed before sending response to client
    if (serverOnlyKeys.length > 0) {
      perms.protectedFields.temporaryKeys = serverOnlyKeys;
    }
    let protectedKeys = protectedKeysSets.reduce((acc, next) => {
      if (next) {
        acc.push(...next);
      }
      return acc;
    }, []);

    // intersect all sets of protectedFields
    protectedKeysSets.forEach(fields => {
      if (fields) {
        protectedKeys = protectedKeys.filter(v => fields.includes(v));
      }
    });
    return protectedKeys;
  }
  createTransactionalSession() {
    if (this._transactionalSession || this._transactionalSessionPending) {
      return Promise.reject(new Error('There is already an active transactional session'));
    }
    // Reserve the session before it is created, without setting `_transactionalSession`, which
    // concurrent writes on this controller would otherwise use
    this._transactionalSessionPending = true;
    return Promise.resolve().then(() => this.adapter.createTransactionalSession()).then(transactionalSession => {
      this._transactionalSession = transactionalSession;
    }).finally(() => {
      this._transactionalSessionPending = false;
    });
  }
  commitTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to commit');
    }
    return this.adapter.commitTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }
  abortTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to abort');
    }
    return this.adapter.abortTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }

  // TODO: create indexes on first creation of a _User object. Otherwise it's impossible to
  // have a Parse app without it having a _User collection.
  async performInitialization() {
    await this.adapter.performInitialization({
      VolatileClassesSchemas: SchemaController.VolatileClassesSchemas
    });
    const requiredUserFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._User
      }
    };
    const requiredRoleFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._Role
      }
    };
    const requiredIdempotencyFields = {
      fields: {
        ...SchemaController.defaultColumns._Default,
        ...SchemaController.defaultColumns._Idempotency
      }
    };
    await this.loadSchema().then(schema => schema.enforceClassExists('_User'));
    await this.loadSchema().then(schema => schema.enforceClassExists('_Role'));
    await this.loadSchema().then(schema => schema.enforceClassExists('_Idempotency'));
    const databaseOptions = this.options.databaseOptions || {};
    if (databaseOptions.createIndexUserUsername !== false) {
      await this.adapter.ensureUniqueness('_User', requiredUserFields, ['username']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for usernames: ', error);
        throw error;
      });
    }
    if (!this.options.enableCollationCaseComparison) {
      if (databaseOptions.createIndexUserUsernameCaseInsensitive !== false) {
        await this.adapter.ensureIndex('_User', requiredUserFields, ['username'], 'case_insensitive_username', true).catch(error => {
          _logger.default.warn('Unable to create case insensitive username index: ', error);
          throw error;
        });
      }
      if (databaseOptions.createIndexUserEmailCaseInsensitive !== false) {
        await this.adapter.ensureIndex('_User', requiredUserFields, ['email'], 'case_insensitive_email', true).catch(error => {
          _logger.default.warn('Unable to create case insensitive email index: ', error);
          throw error;
        });
      }
    }
    if (databaseOptions.createIndexUserEmail !== false) {
      await this.adapter.ensureUniqueness('_User', requiredUserFields, ['email']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for user email addresses: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexUserEmailVerifyToken !== false) {
      await this.adapter.ensureIndex('_User', requiredUserFields, ['_email_verify_token'], '_email_verify_token', false).catch(error => {
        _logger.default.warn('Unable to create index for email verification token: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexUserPasswordResetToken !== false) {
      await this.adapter.ensureIndex('_User', requiredUserFields, ['_perishable_token'], '_perishable_token', false).catch(error => {
        _logger.default.warn('Unable to create index for password reset token: ', error);
        throw error;
      });
    }
    if (databaseOptions.createIndexRoleName !== false) {
      await this.adapter.ensureUniqueness('_Role', requiredRoleFields, ['name']).catch(error => {
        _logger.default.warn('Unable to ensure uniqueness for role name: ', error);
        throw error;
      });
    }
    await this.adapter.ensureUniqueness('_Idempotency', requiredIdempotencyFields, ['reqId']).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for idempotency request ID: ', error);
      throw error;
    });
    const isMongoAdapter = this.adapter instanceof _MongoStorageAdapter.default;
    const isPostgresAdapter = this.adapter instanceof _PostgresStorageAdapter.default;
    if (isMongoAdapter || isPostgresAdapter) {
      let options = {};
      if (isMongoAdapter) {
        options = {
          ttl: 0
        };
      } else if (isPostgresAdapter) {
        options = this.idempotencyOptions;
        options.setIdempotencyFunction = true;
      }
      await this.adapter.ensureIndex('_Idempotency', requiredIdempotencyFields, ['expire'], 'ttl', false, options).catch(error => {
        _logger.default.warn('Unable to create TTL index for idempotency expire date: ', error);
        throw error;
      });
    }
    // Create unique indexes for authData providers to prevent race conditions
    // during concurrent signups with the same authData
    if (databaseOptions.createIndexAuthDataUniqueness !== false && typeof this.adapter.ensureAuthDataUniqueness === 'function') {
      const authProviders = Object.keys(this.options.auth || {});
      if (this.options.enableAnonymousUsers !== false) {
        if (!authProviders.includes('anonymous')) {
          authProviders.push('anonymous');
        }
      }
      await Promise.all(authProviders.map(provider => this.adapter.ensureAuthDataUniqueness(provider).catch(error => {
        _logger.default.warn(`Unable to ensure uniqueness for auth data provider "${provider}": `, error);
      })));
    }
    await this.adapter.updateSchemaWithIndexes();
  }
  _expandResultOnKeyPath(object, key, value) {
    if (key.indexOf('.') < 0) {
      object[key] = value[key];
      return object;
    }
    const path = key.split('.');
    const firstKey = path[0];
    const nextPath = path.slice(1).join('.');

    // Scan request data for denied keywords
    if (this.options && this.options.requestKeywordDenylist) {
      // Scan request data for denied keywords
      for (const keyword of this.options.requestKeywordDenylist) {
        const match = _Utils.default.objectContainsKeyValue({
          [firstKey]: true,
          [nextPath]: true
        }, keyword.key, true);
        if (match) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Prohibited keyword in request data: ${JSON.stringify(keyword)}.`);
        }
      }
    }

    // Only descend into an own object, never an inherited prototype member
    const child = Object.hasOwn(object, firstKey) && object[firstKey] && typeof object[firstKey] === 'object' ? object[firstKey] : {};
    object[firstKey] = this._expandResultOnKeyPath(child, nextPath, value[firstKey]);
    delete object[key];
    return object;
  }
  _sanitizeDatabaseResult(originalObject, result) {
    const response = {};
    if (!result) {
      return Promise.resolve(response);
    }
    Object.keys(originalObject).forEach(key => {
      const keyUpdate = originalObject[key];
      // determine if that was an op
      if (keyUpdate && typeof keyUpdate === 'object' && keyUpdate.__op && ['Add', 'AddUnique', 'Remove', 'Increment', 'SetOnInsert'].indexOf(keyUpdate.__op) > -1) {
        // only valid ops that produce an actionable result
        // the op may have happened on a keypath
        this._expandResultOnKeyPath(response, key, result);
        // Revert array to object conversion on dot notation for arrays (e.g. "field.0.key")
        if (key.includes('.')) {
          const [field, index] = key.split('.');
          const isArrayIndex = Array.from(index).every(c => c >= '0' && c <= '9');
          if (isArrayIndex && Array.isArray(result[field]) && !Array.isArray(response[field])) {
            response[field] = result[field];
          }
        }
      }
    });
    return Promise.resolve(response);
  }
}
module.exports = DatabaseController;
// Expose validateQuery for tests
module.exports._validateQuery = validateQuery;
module.exports.filterSensitiveData = filterSensitiveData;
module.exports.validateQueryFormat = validateQueryFormat;
module.exports.logicalOperatorError = logicalOperatorError;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsInJlcXVpcmUiLCJfbG9kYXNoIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsIl9pbnRlcnNlY3QiLCJfbG9nZ2VyIiwiX1V0aWxzIiwiU2NoZW1hQ29udHJvbGxlciIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX1N0b3JhZ2VBZGFwdGVyIiwiX01vbmdvU3RvcmFnZUFkYXB0ZXIiLCJfUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsIl9TY2hlbWFDYWNoZSIsIl9FcnJvciIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsInF1ZXJ5T3BlcmF0b3JzIiwiaW50ZXJuYWxGaWVsZHMiLCJfcnBlcm0iLCJjbGllbnRSZWFkIiwibWFzdGVyUmVhZCIsIm1hc3RlcldyaXRlIiwiX3dwZXJtIiwiX2hhc2hlZF9wYXNzd29yZCIsIl9lbWFpbF92ZXJpZnlfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQiLCJfZmFpbGVkX2xvZ2luX2NvdW50IiwiX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJfcGFzc3dvcmRfaGlzdG9yeSIsIl90b21ic3RvbmUiLCJfc2Vzc2lvbl90b2tlbiIsInNwZWNpYWxRdWVyeUtleXMiLCJrZXlzIiwiZmlsdGVyIiwiayIsInNwZWNpYWxNYXN0ZXJRdWVyeUtleXMiLCJhZGRXcml0ZUFDTCIsInF1ZXJ5IiwiYWNsIiwibmV3UXVlcnkiLCJfIiwiY2xvbmVEZWVwIiwiJGluIiwiYWRkUmVhZEFDTCIsInRyYW5zZm9ybU9iamVjdEFDTCIsIkFDTCIsInJlc3VsdCIsImVudHJ5IiwicmVhZCIsInB1c2giLCJ3cml0ZSIsImxvZ2ljYWxPcGVyYXRvckVycm9yIiwib3AiLCJ2YWx1ZSIsIm1lc3NhZ2UiLCJBcnJheSIsImlzQXJyYXkiLCJQYXJzZSIsIkVycm9yIiwiSU5WQUxJRF9RVUVSWSIsInZhbGlkYXRlUXVlcnlGb3JtYXQiLCJVdGlscyIsImlzT2JqZWN0Iiwic3ViUXVlcmllcyIsInVuZGVmaW5lZCIsImxlbmd0aCIsInN1YlF1ZXJ5Iiwia2V5IiwiY29uc3RyYWludCIsIiRvcHRpb25zIiwiJHJlZ2V4IiwidmFsaWRhdGVRdWVyeSIsImlzTWFzdGVyIiwiaXNNYWludGVuYW5jZSIsInVwZGF0ZSIsIm9wdGlvbnMiLCJfZGVwdGgiLCJyYyIsInJlcXVlc3RDb21wbGV4aXR5IiwicXVlcnlEZXB0aCIsImZvckVhY2giLCJhbGxvd1JlZ2V4IiwibWF0Y2giLCJpbmNsdWRlcyIsIklOVkFMSURfS0VZX05BTUUiLCJmaWx0ZXJTZW5zaXRpdmVEYXRhIiwiYWNsR3JvdXAiLCJhdXRoIiwib3BlcmF0aW9uIiwic2NoZW1hIiwiY2xhc3NOYW1lIiwicHJvdGVjdGVkRmllbGRzIiwib2JqZWN0IiwicHJvdGVjdGVkRmllbGRzT3duZXJFeGVtcHQiLCJ1c2VySWQiLCJ1c2VyIiwiaWQiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlzUmVhZE9wZXJhdGlvbiIsImluZGV4T2YiLCJwcm90ZWN0ZWRGaWVsZHNQb2ludGVyUGVybSIsInN0YXJ0c1dpdGgiLCJtYXAiLCJzdWJzdHJpbmciLCJuZXdQcm90ZWN0ZWRGaWVsZHMiLCJvdmVycmlkZVByb3RlY3RlZEZpZWxkcyIsInBvaW50ZXJQZXJtIiwicG9pbnRlclBlcm1JbmNsdWRlc1VzZXIiLCJyZWFkVXNlckZpZWxkVmFsdWUiLCJzb21lIiwib2JqZWN0SWQiLCJmaWVsZHMiLCJ2IiwiaXNVc2VyQ2xhc3MiLCJwYXNzd29yZCIsInNlc3Npb25Ub2tlbiIsImlzT3duZXJFeGVtcHQiLCJ0ZW1wb3JhcnlLZXlzIiwiY2hhckF0IiwiYXV0aERhdGEiLCJzcGVjaWFsS2V5c0ZvclVwZGF0ZSIsImlzU3BlY2lhbFVwZGF0ZUtleSIsImpvaW5UYWJsZU5hbWUiLCJmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlIiwiX19vcCIsImFtb3VudCIsIklOVkFMSURfSlNPTiIsIm9iamVjdHMiLCJDT01NQU5EX1VOQVZBSUxBQkxFIiwidHJhbnNmb3JtQXV0aERhdGEiLCJwcm92aWRlciIsInByb3ZpZGVyRGF0YSIsImZpZWxkTmFtZSIsInR5cGUiLCJ1bnRyYW5zZm9ybU9iamVjdEFDTCIsIm91dHB1dCIsImhhc093biIsImdldFJvb3RGaWVsZE5hbWUiLCJzcGxpdCIsInJlbGF0aW9uU2NoZW1hIiwicmVsYXRlZElkIiwib3duaW5nSWQiLCJjb252ZXJ0RW1haWxUb0xvd2VyY2FzZSIsInRvTG93ZXJDYXNlIiwiY29udmVydFVzZXJuYW1lVG9Mb3dlcmNhc2UiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJjb25zdHJ1Y3RvciIsImFkYXB0ZXIiLCJpZGVtcG90ZW5jeU9wdGlvbnMiLCJzY2hlbWFQcm9taXNlIiwiX3RyYW5zYWN0aW9uYWxTZXNzaW9uIiwiX3RyYW5zYWN0aW9uYWxTZXNzaW9uUGVuZGluZyIsImNvbGxlY3Rpb25FeGlzdHMiLCJjbGFzc0V4aXN0cyIsInB1cmdlQ29sbGVjdGlvbiIsImxvYWRTY2hlbWEiLCJ0aGVuIiwic2NoZW1hQ29udHJvbGxlciIsImdldE9uZVNjaGVtYSIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5IiwidmFsaWRhdGVDbGFzc05hbWUiLCJjbGFzc05hbWVJc1ZhbGlkIiwiUHJvbWlzZSIsInJlamVjdCIsIklOVkFMSURfQ0xBU1NfTkFNRSIsInJlc29sdmUiLCJjbGVhckNhY2hlIiwibG9hZCIsImxvYWRTY2hlbWFJZk5lZWRlZCIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwiZ2V0RXhwZWN0ZWRUeXBlIiwidGFyZ2V0Q2xhc3MiLCJ2YWxpZGF0ZU9iamVjdCIsInJ1bk9wdGlvbnMiLCJtYWludGVuYW5jZSIsInMiLCJjYW5BZGRGaWVsZCIsIm1hbnkiLCJ1cHNlcnQiLCJhZGRzRmllbGQiLCJza2lwU2FuaXRpemF0aW9uIiwidmFsaWRhdGVPbmx5IiwidmFsaWRTY2hlbWFDb250cm9sbGVyIiwiY2hlY2tQcm9oaWJpdGVkS2V5d29yZHMiLCJlcnJvciIsInZhbGlkYXRlRmlsZVVybHNJbk9iamVjdCIsIkZJTEVfU0FWRV9FUlJPUiIsIm9yaWdpbmFsUXVlcnkiLCJvcmlnaW5hbFVwZGF0ZSIsInN0cnVjdHVyZWRDbG9uZSIsInJlbGF0aW9uVXBkYXRlcyIsInZhbGlkYXRlUGVybWlzc2lvbiIsImNvbGxlY3RSZWxhdGlvblVwZGF0ZXMiLCJhZGRQb2ludGVyUGVybWlzc2lvbnMiLCIkYW5kIiwiY2F0Y2giLCJyb290RmllbGROYW1lIiwiZmllbGROYW1lSXNWYWxpZCIsInVwZGF0ZU9wZXJhdGlvbiIsImlubmVyS2V5IiwiSU5WQUxJRF9ORVNURURfS0VZIiwiZmluZCIsInJlYWRQcmVmZXJlbmNlIiwiT0JKRUNUX05PVF9GT1VORCIsInVwZGF0ZU9iamVjdHNCeVF1ZXJ5IiwidXBzZXJ0T25lT2JqZWN0IiwiZmluZE9uZUFuZFVwZGF0ZSIsImhhbmRsZVJlbGF0aW9uVXBkYXRlcyIsIm1hdGNoZWRDb3VudCIsIm1vZGlmaWVkQ291bnQiLCJfc2FuaXRpemVEYXRhYmFzZVJlc3VsdCIsIm9wcyIsImRlbGV0ZU1lIiwicHJvY2VzcyIsIngiLCJwZW5kaW5nIiwiYWRkUmVsYXRpb24iLCJyZW1vdmVSZWxhdGlvbiIsImFsbCIsImZyb21DbGFzc05hbWUiLCJmcm9tSWQiLCJ0b0lkIiwiZG9jIiwiY29kZSIsImRlc3Ryb3kiLCJwYXJzZUZvcm1hdFNjaGVtYSIsImNyZWF0ZSIsIm9yaWdpbmFsT2JqZWN0IiwiY3JlYXRlZEF0IiwiaXNvIiwiX190eXBlIiwidXBkYXRlZEF0IiwiZW5mb3JjZUNsYXNzRXhpc3RzIiwiY3JlYXRlT2JqZWN0IiwiY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYSIsImNsYXNzU2NoZW1hIiwic2NoZW1hRGF0YSIsInNjaGVtYUZpZWxkcyIsIm5ld0tleXMiLCJmaWVsZCIsImFjdGlvbiIsImRlbGV0ZUV2ZXJ5dGhpbmciLCJmYXN0IiwiU2NoZW1hQ2FjaGUiLCJjbGVhciIsImRlbGV0ZUFsbENsYXNzZXMiLCJyZWxhdGVkSWRzIiwicXVlcnlPcHRpb25zIiwic2tpcCIsImxpbWl0Iiwic29ydCIsImZpbmRPcHRpb25zIiwiY2FuU29ydE9uSm9pblRhYmxlcyIsIl9pZCIsInJlc3VsdHMiLCJvd25pbmdJZHMiLCJyZWR1Y2VJblJlbGF0aW9uIiwicHJvbWlzZXMiLCJvcnMiLCJhUXVlcnkiLCJpbmRleCIsImFuZHMiLCJvdGhlcktleXMiLCJxdWVyaWVzIiwiY29uc3RyYWludEtleSIsImlzTmVnYXRpb24iLCJxIiwiaWRzIiwiYWRkTm90SW5PYmplY3RJZHNJZHMiLCJhZGRJbk9iamVjdElkc0lkcyIsInJlZHVjZVJlbGF0aW9uS2V5cyIsInJlbGF0ZWRUbyIsInJlbGF0ZWRUb09iamVjdCIsImF1dGhvcml6ZVJlbGF0ZWRUb1F1ZXJ5IiwiY2FuUmVhZE93bmluZ09iamVjdCIsIm93bmluZ0NsYXNzTmFtZSIsInJlbGF0aW9uS2V5IiwibG9hZGVkU2NoZW1hIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwicm9vdEZpZWxkIiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiaWRzRnJvbVN0cmluZyIsImlkc0Zyb21FcSIsImlkc0Zyb21JbiIsImFsbElkcyIsImxpc3QiLCJ0b3RhbExlbmd0aCIsInJlZHVjZSIsIm1lbW8iLCJpZHNJbnRlcnNlY3Rpb24iLCJpbnRlcnNlY3QiLCJiaWciLCIkZXEiLCJpZHNGcm9tTmluIiwiU2V0IiwiJG5pbiIsImNvdW50IiwiZGlzdGluY3QiLCJwaXBlbGluZSIsImhpbnQiLCJjYXNlSW5zZW5zaXRpdmUiLCJleHBsYWluIiwiY29tbWVudCIsInJhd1ZhbHVlcyIsInJhd0ZpZWxkTmFtZXMiLCJfY3JlYXRlZF9hdCIsIl91cGRhdGVkX2F0IiwiZW5hYmxlQ29sbGF0aW9uQ2FzZUNvbXBhcmlzb24iLCJhZ2dyZWdhdGUiLCJkZXRhaWxlZE1lc3NhZ2UiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJkZWxldGVTY2hlbWEiLCJkZWxldGVDbGFzcyIsIndhc1BhcnNlQ29sbGVjdGlvbiIsInJlbGF0aW9uRmllbGROYW1lcyIsIm5hbWUiLCJkZWwiLCJyZWxvYWREYXRhIiwib2JqZWN0VG9FbnRyaWVzU3RyaW5ncyIsImVudHJpZXMiLCJhIiwiSlNPTiIsInN0cmluZ2lmeSIsImpvaW4iLCJyZWR1Y2VPck9wZXJhdGlvbiIsIiRvciIsInJlcGVhdCIsImoiLCJzaG9ydGVyIiwibG9uZ2VyIiwiZm91bmRFbnRyaWVzIiwiYWNjIiwic2hvcnRlckVudHJpZXMiLCJzcGxpY2UiLCJyZWR1Y2VBbmRPcGVyYXRpb24iLCJ0ZXN0UGVybWlzc2lvbnNGb3JDbGFzc05hbWUiLCJ1c2VyQUNMIiwiZ3JvdXBLZXkiLCJwZXJtRmllbGRzIiwicG9pbnRlckZpZWxkcyIsInVzZXJQb2ludGVyIiwiZmllbGREZXNjcmlwdG9yIiwiZmllbGRUeXBlIiwicHJvdG90eXBlIiwicXVlcnlDbGF1c2UiLCIkYWxsIiwiYXNzaWduIiwicHJlc2VydmVLZXlzIiwic2VydmVyT25seUtleXMiLCJhdXRoZW50aWNhdGVkIiwicm9sZXMiLCJ1c2VyUm9sZXMiLCJwcm90ZWN0ZWRLZXlzU2V0cyIsInByb3RlY3RlZEtleXMiLCJuZXh0IiwiY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24iLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsImZpbmFsbHkiLCJjb21taXRUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsImFib3J0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJWb2xhdGlsZUNsYXNzZXNTY2hlbWFzIiwicmVxdWlyZWRVc2VyRmllbGRzIiwiZGVmYXVsdENvbHVtbnMiLCJfRGVmYXVsdCIsIl9Vc2VyIiwicmVxdWlyZWRSb2xlRmllbGRzIiwiX1JvbGUiLCJyZXF1aXJlZElkZW1wb3RlbmN5RmllbGRzIiwiX0lkZW1wb3RlbmN5IiwiZGF0YWJhc2VPcHRpb25zIiwiY3JlYXRlSW5kZXhVc2VyVXNlcm5hbWUiLCJlbnN1cmVVbmlxdWVuZXNzIiwibG9nZ2VyIiwid2FybiIsImNyZWF0ZUluZGV4VXNlclVzZXJuYW1lQ2FzZUluc2Vuc2l0aXZlIiwiZW5zdXJlSW5kZXgiLCJjcmVhdGVJbmRleFVzZXJFbWFpbENhc2VJbnNlbnNpdGl2ZSIsImNyZWF0ZUluZGV4VXNlckVtYWlsIiwiY3JlYXRlSW5kZXhVc2VyRW1haWxWZXJpZnlUb2tlbiIsImNyZWF0ZUluZGV4VXNlclBhc3N3b3JkUmVzZXRUb2tlbiIsImNyZWF0ZUluZGV4Um9sZU5hbWUiLCJpc01vbmdvQWRhcHRlciIsIk1vbmdvU3RvcmFnZUFkYXB0ZXIiLCJpc1Bvc3RncmVzQWRhcHRlciIsIlBvc3RncmVzU3RvcmFnZUFkYXB0ZXIiLCJ0dGwiLCJzZXRJZGVtcG90ZW5jeUZ1bmN0aW9uIiwiY3JlYXRlSW5kZXhBdXRoRGF0YVVuaXF1ZW5lc3MiLCJlbnN1cmVBdXRoRGF0YVVuaXF1ZW5lc3MiLCJhdXRoUHJvdmlkZXJzIiwiZW5hYmxlQW5vbnltb3VzVXNlcnMiLCJ1cGRhdGVTY2hlbWFXaXRoSW5kZXhlcyIsIl9leHBhbmRSZXN1bHRPbktleVBhdGgiLCJwYXRoIiwiZmlyc3RLZXkiLCJuZXh0UGF0aCIsInNsaWNlIiwicmVxdWVzdEtleXdvcmREZW55bGlzdCIsImtleXdvcmQiLCJvYmplY3RDb250YWluc0tleVZhbHVlIiwiY2hpbGQiLCJyZXNwb25zZSIsImtleVVwZGF0ZSIsImlzQXJyYXlJbmRleCIsImZyb20iLCJldmVyeSIsImMiLCJtb2R1bGUiLCJleHBvcnRzIiwiX3ZhbGlkYXRlUXVlcnkiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvQ29udHJvbGxlcnMvRGF0YWJhc2VDb250cm9sbGVyLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIu+7vy8vIEBmbG93XG4vLyBBIGRhdGFiYXNlIGFkYXB0ZXIgdGhhdCB3b3JrcyB3aXRoIGRhdGEgZXhwb3J0ZWQgZnJvbSB0aGUgaG9zdGVkXG4vLyBQYXJzZSBkYXRhYmFzZS5cblxuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgeyBQYXJzZSB9IGZyb20gJ3BhcnNlL25vZGUnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgaW50ZXJzZWN0IGZyb20gJ2ludGVyc2VjdCc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgVXRpbHMgZnJvbSAnLi4vVXRpbHMnO1xuaW1wb3J0ICogYXMgU2NoZW1hQ29udHJvbGxlciBmcm9tICcuL1NjaGVtYUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgU3RvcmFnZUFkYXB0ZXIgfSBmcm9tICcuLi9BZGFwdGVycy9TdG9yYWdlL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCBNb25nb1N0b3JhZ2VBZGFwdGVyIGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvTW9uZ28vTW9uZ29TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgUG9zdGdyZXNTdG9yYWdlQWRhcHRlciBmcm9tICcuLi9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IFNjaGVtYUNhY2hlIGZyb20gJy4uL0FkYXB0ZXJzL0NhY2hlL1NjaGVtYUNhY2hlJztcbmltcG9ydCB0eXBlIHsgTG9hZFNjaGVtYU9wdGlvbnMgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB0eXBlIHsgUGFyc2VTZXJ2ZXJPcHRpb25zIH0gZnJvbSAnLi4vT3B0aW9ucyc7XG5pbXBvcnQgdHlwZSB7IFF1ZXJ5T3B0aW9ucywgRnVsbFF1ZXJ5T3B0aW9ucyB9IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuLi9FcnJvcic7XG5cbi8vIFF1ZXJ5IG9wZXJhdG9ycyB0aGF0IGFsd2F5cyBwYXNzIHZhbGlkYXRpb24gcmVnYXJkbGVzcyBvZiBhdXRoIGxldmVsLlxuY29uc3QgcXVlcnlPcGVyYXRvcnMgPSBbJyRhbmQnLCAnJG9yJywgJyRub3InXTtcblxuLy8gUmVnaXN0cnkgb2YgaW50ZXJuYWwgZmllbGRzIHdpdGggYWNjZXNzIHBlcm1pc3Npb25zLlxuLy8gSW50ZXJuYWwgZmllbGRzIGFyZSBuZXZlciBkaXJlY3RseSB3cml0YWJsZSBieSBjbGllbnRzLCBzbyBjbGllbnRXcml0ZSBpcyBvbWl0dGVkLlxuLy8gLSBjbGllbnRSZWFkOiBhbnkgY2xpZW50IGNhbiB1c2UgdGhpcyBmaWVsZCBpbiBxdWVyaWVzXG4vLyAtIG1hc3RlclJlYWQ6IG1hc3RlciBrZXkgY2FuIHVzZSB0aGlzIGZpZWxkIGluIHF1ZXJpZXNcbi8vIC0gbWFzdGVyV3JpdGU6IG1hc3RlciBrZXkgY2FuIHVzZSB0aGlzIGZpZWxkIGluIHVwZGF0ZXNcbmNvbnN0IGludGVybmFsRmllbGRzID0ge1xuICBfcnBlcm06ICAgICAgICAgICAgICAgICAgICAgICAgIHsgY2xpZW50UmVhZDogdHJ1ZSwgIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3dwZXJtOiAgICAgICAgICAgICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IHRydWUsICBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9oYXNoZWRfcGFzc3dvcmQ6ICAgICAgICAgICAgICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogZmFsc2UsIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfZW1haWxfdmVyaWZ5X3Rva2VuOiAgICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3BlcmlzaGFibGVfdG9rZW46ICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQ6ICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQ6IHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX2ZhaWxlZF9sb2dpbl9jb3VudDogICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdDogICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiB0cnVlICB9LFxuICBfcGFzc3dvcmRfY2hhbmdlZF9hdDogICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogdHJ1ZSAgfSxcbiAgX3Bhc3N3b3JkX2hpc3Rvcnk6ICAgICAgICAgICAgICB7IGNsaWVudFJlYWQ6IGZhbHNlLCBtYXN0ZXJSZWFkOiB0cnVlLCAgbWFzdGVyV3JpdGU6IHRydWUgIH0sXG4gIF90b21ic3RvbmU6ICAgICAgICAgICAgICAgICAgICAgeyBjbGllbnRSZWFkOiBmYWxzZSwgbWFzdGVyUmVhZDogdHJ1ZSwgIG1hc3RlcldyaXRlOiBmYWxzZSB9LFxuICBfc2Vzc2lvbl90b2tlbjogICAgICAgICAgICAgICAgIHsgY2xpZW50UmVhZDogZmFsc2UsIG1hc3RlclJlYWQ6IHRydWUsICBtYXN0ZXJXcml0ZTogZmFsc2UgfSxcbiAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gIC8vIFRoZSBmb2xsb3dpbmcgZmllbGRzIGFyZSBub3QgYWNjZXNzZWQgYnkgdGhlaXIgXy1wcmVmaXhlZCBuYW1lIHRocm91Z2ggdGhlIEFQSTtcbiAgLy8gdGhleSBhcmUgbWFwcGVkIHRvIFJFU1QtbGV2ZWwgbmFtZXMgaW4gdGhlIGFkYXB0ZXIgbGF5ZXIgb3IgaGFuZGxlZCB0aHJvdWdoXG4gIC8vIHNlcGFyYXRlIGNvZGUgcGF0aHMuXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBTeXN0ZW0gZmllbGRzIChtYXBwZWQgdG8gUkVTVC1sZXZlbCBuYW1lcyk6XG4gIC8vIF9pZCAob2JqZWN0SWQpXG4gIC8vIF9jcmVhdGVkX2F0IChjcmVhdGVkQXQpXG4gIC8vIF91cGRhdGVkX2F0ICh1cGRhdGVkQXQpXG4gIC8vIF9sYXN0X3VzZWQgKGxhc3RVc2VkKVxuICAvLyBfZXhwaXJlc0F0IChleHBpcmVzQXQpXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBMZWdhY3kgQUNMIGZvcm1hdDogbWFwcGVkIHRvL2Zyb20gX3JwZXJtL193cGVybVxuICAvLyBfYWNsXG4gIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAvLyBTY2hlbWEgbWV0YWRhdGE6IG5vdCBkYXRhIGZpZWxkcywgdXNlZCBvbmx5IGZvciBzY2hlbWEgY29uZmlndXJhdGlvblxuICAvLyBfbWV0YWRhdGFcbiAgLy8gX2NsaWVudF9wZXJtaXNzaW9uc1xuICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgLy8gRHluYW1pYyBhdXRoIGRhdGEgZmllbGRzOiB1c2VkIG9ubHkgaW4gcHJvamVjdGlvbnMgYW5kIHVwZGF0ZXMsIG5vdCBpbiBxdWVyaWVzXG4gIC8vIF9hdXRoX2RhdGFfPHByb3ZpZGVyPlxufTtcblxuLy8gRGVyaXZlZCBhY2Nlc3MgbGlzdHNcbmNvbnN0IHNwZWNpYWxRdWVyeUtleXMgPSBbXG4gIC4uLnF1ZXJ5T3BlcmF0b3JzLFxuICAuLi5PYmplY3Qua2V5cyhpbnRlcm5hbEZpZWxkcykuZmlsdGVyKGsgPT4gaW50ZXJuYWxGaWVsZHNba10uY2xpZW50UmVhZCksXG5dO1xuY29uc3Qgc3BlY2lhbE1hc3RlclF1ZXJ5S2V5cyA9IFtcbiAgLi4ucXVlcnlPcGVyYXRvcnMsXG4gIC4uLk9iamVjdC5rZXlzKGludGVybmFsRmllbGRzKS5maWx0ZXIoayA9PiBpbnRlcm5hbEZpZWxkc1trXS5tYXN0ZXJSZWFkKSxcbl07XG5cbmZ1bmN0aW9uIGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpIHtcbiAgY29uc3QgbmV3UXVlcnkgPSBfLmNsb25lRGVlcChxdWVyeSk7XG4gIC8vQ2FuJ3QgYmUgYW55IGV4aXN0aW5nICdfd3Blcm0nIHF1ZXJ5LCB3ZSBkb24ndCBhbGxvdyBjbGllbnQgcXVlcmllcyBvbiB0aGF0LCBubyBuZWVkIHRvICRhbmRcbiAgbmV3UXVlcnkuX3dwZXJtID0geyAkaW46IFtudWxsLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuZnVuY3Rpb24gYWRkUmVhZEFDTChxdWVyeSwgYWNsKSB7XG4gIGNvbnN0IG5ld1F1ZXJ5ID0gXy5jbG9uZURlZXAocXVlcnkpO1xuICAvL0Nhbid0IGJlIGFueSBleGlzdGluZyAnX3JwZXJtJyBxdWVyeSwgd2UgZG9uJ3QgYWxsb3cgY2xpZW50IHF1ZXJpZXMgb24gdGhhdCwgbm8gbmVlZCB0byAkYW5kXG4gIG5ld1F1ZXJ5Ll9ycGVybSA9IHsgJGluOiBbbnVsbCwgJyonLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuLy8gVHJhbnNmb3JtcyBhIFJFU1QgQVBJIGZvcm1hdHRlZCBBQ0wgb2JqZWN0IHRvIG91ciB0d28tZmllbGQgbW9uZ28gZm9ybWF0LlxuY29uc3QgdHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgQUNMLCAuLi5yZXN1bHQgfSkgPT4ge1xuICBpZiAoIUFDTCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICByZXN1bHQuX3dwZXJtID0gW107XG4gIHJlc3VsdC5fcnBlcm0gPSBbXTtcblxuICBmb3IgKGNvbnN0IGVudHJ5IGluIEFDTCkge1xuICAgIGlmIChBQ0xbZW50cnldLnJlYWQpIHtcbiAgICAgIHJlc3VsdC5fcnBlcm0ucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIGlmIChBQ0xbZW50cnldLndyaXRlKSB7XG4gICAgICByZXN1bHQuX3dwZXJtLnB1c2goZW50cnkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufTtcblxuLy8gRXJyb3IgZm9yIGEgbG9naWNhbCBvcGVyYXRvciB2YWx1ZSB0aGF0IGlzIG5vdCBhIG5vbi1lbXB0eSBhcnJheVxuY29uc3QgbG9naWNhbE9wZXJhdG9yRXJyb3IgPSAob3A6IHN0cmluZywgdmFsdWU6IGFueSkgPT4ge1xuICBjb25zdCBtZXNzYWdlID1cbiAgICBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBvcCA9PT0gJyRub3InXG4gICAgICA/IGBCYWQgJHtvcH0gZm9ybWF0IC0gdXNlIGFuIGFycmF5IG9mIGF0IGxlYXN0IDEgdmFsdWUuYFxuICAgICAgOiBgQmFkICR7b3B9IGZvcm1hdCAtIHVzZSBhbiBhcnJheSB2YWx1ZS5gO1xuICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIG1lc3NhZ2UpO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoZSBmb3JtYXQgb2YgbG9naWNhbCBvcGVyYXRvcnMgYW5kICRvcHRpb25zIGJlZm9yZSB0aGUgcXVlcnkgaXMgcHJvY2Vzc2VkXG5jb25zdCB2YWxpZGF0ZVF1ZXJ5Rm9ybWF0ID0gKHF1ZXJ5OiBhbnkpOiB2b2lkID0+IHtcbiAgaWYgKCFVdGlscy5pc09iamVjdChxdWVyeSkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBvcCBvZiBxdWVyeU9wZXJhdG9ycykge1xuICAgIGNvbnN0IHN1YlF1ZXJpZXMgPSBxdWVyeVtvcF07XG4gICAgaWYgKHN1YlF1ZXJpZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShzdWJRdWVyaWVzKSB8fCBzdWJRdWVyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbG9naWNhbE9wZXJhdG9yRXJyb3Iob3AsIHN1YlF1ZXJpZXMpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YlF1ZXJ5IG9mIHN1YlF1ZXJpZXMpIHtcbiAgICAgIC8vIFVuY29uc3RyYWluZWQgcXVlcnkgc2VudCBhcyBlbXB0eSBhcnJheSBieSBzb21lIFNES3NcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHN1YlF1ZXJ5KSAmJiBzdWJRdWVyeS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoIVV0aWxzLmlzT2JqZWN0KHN1YlF1ZXJ5KSB8fCBBcnJheS5pc0FycmF5KHN1YlF1ZXJ5KSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICBgQmFkICR7b3B9IGZvcm1hdCAtIHVzZSBhbiBhcnJheSBvZiBvYmplY3RzLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHZhbGlkYXRlUXVlcnlGb3JtYXQoc3ViUXVlcnkpO1xuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhxdWVyeSkpIHtcbiAgICBjb25zdCBjb25zdHJhaW50ID0gcXVlcnlba2V5XTtcbiAgICBpZiAoXG4gICAgICBVdGlscy5pc09iamVjdChjb25zdHJhaW50KSAmJlxuICAgICAgY29uc3RyYWludC4kb3B0aW9ucyAhPT0gdW5kZWZpbmVkICYmXG4gICAgICBjb25zdHJhaW50LiRyZWdleCA9PT0gdW5kZWZpbmVkXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRvcHRpb25zIHJlcXVpcmVzICRyZWdleCcpO1xuICAgIH1cbiAgfVxufTtcblxuY29uc3QgdmFsaWRhdGVRdWVyeSA9IChcbiAgcXVlcnk6IGFueSxcbiAgaXNNYXN0ZXI6IGJvb2xlYW4sXG4gIGlzTWFpbnRlbmFuY2U6IGJvb2xlYW4sXG4gIHVwZGF0ZTogYm9vbGVhbixcbiAgb3B0aW9uczogP1BhcnNlU2VydmVyT3B0aW9ucyxcbiAgX2RlcHRoOiBudW1iZXIgPSAwXG4pOiB2b2lkID0+IHtcbiAgaWYgKGlzTWFpbnRlbmFuY2UpIHtcbiAgICBpc01hc3RlciA9IHRydWU7XG4gIH1cbiAgY29uc3QgcmMgPSBvcHRpb25zPy5yZXF1ZXN0Q29tcGxleGl0eTtcbiAgaWYgKCFpc01hc3RlciAmJiByYyAmJiByYy5xdWVyeURlcHRoICE9PSAtMSAmJiBfZGVwdGggPiByYy5xdWVyeURlcHRoKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgIGBRdWVyeSBjb25kaXRpb24gbmVzdGluZyBkZXB0aCBleGNlZWRzIG1heGltdW0gYWxsb3dlZCBkZXB0aCBvZiAke3JjLnF1ZXJ5RGVwdGh9YFxuICAgICk7XG4gIH1cbiAgaWYgKHF1ZXJ5LkFDTCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCAnQ2Fubm90IHF1ZXJ5IG9uIEFDTC4nKTtcbiAgfVxuXG4gIGZvciAoY29uc3Qgb3Agb2YgcXVlcnlPcGVyYXRvcnMpIHtcbiAgICBpZiAocXVlcnlbb3BdID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocXVlcnlbb3BdKSB8fCBxdWVyeVtvcF0ubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBsb2dpY2FsT3BlcmF0b3JFcnJvcihvcCwgcXVlcnlbb3BdKTtcbiAgICB9XG4gICAgcXVlcnlbb3BdLmZvckVhY2godmFsdWUgPT5cbiAgICAgIHZhbGlkYXRlUXVlcnkodmFsdWUsIGlzTWFzdGVyLCBpc01haW50ZW5hbmNlLCB1cGRhdGUsIG9wdGlvbnMsIF9kZXB0aCArIDEpXG4gICAgKTtcbiAgfVxuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgaWYgKHF1ZXJ5ICYmIHF1ZXJ5W2tleV0gJiYgcXVlcnlba2V5XS4kcmVnZXggIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKCFpc01hc3RlciAmJiByYyAmJiByYy5hbGxvd1JlZ2V4ID09PSBmYWxzZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRyZWdleCBvcGVyYXRvciBpcyBub3QgYWxsb3dlZCcpO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBxdWVyeVtrZXldLiRyZWdleCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICckcmVnZXggdmFsdWUgbXVzdCBiZSBhIHN0cmluZycpO1xuICAgICAgfVxuICAgICAgaWYgKHF1ZXJ5W2tleV0uJG9wdGlvbnMgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgcXVlcnlba2V5XS4kb3B0aW9ucyAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICckb3B0aW9ucyB2YWx1ZSBtdXN0IGJlIGEgc3RyaW5nJyk7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHF1ZXJ5W2tleV0uJG9wdGlvbnMgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGlmICghcXVlcnlba2V5XS4kb3B0aW9ucy5tYXRjaCgvXltpbXhzdV0rJC8pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgIGBCYWQgJG9wdGlvbnMgdmFsdWUgZm9yIHF1ZXJ5OiAke3F1ZXJ5W2tleV0uJG9wdGlvbnN9YFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKFxuICAgICAgIWtleS5tYXRjaCgvXlthLXpBLVpdW2EtekEtWjAtOV9cXC5dKiQvKSAmJlxuICAgICAgIXNwZWNpYWxRdWVyeUtleXMuaW5jbHVkZXMoa2V5KSAmJlxuICAgICAgIShpc01hc3RlciAmJiBzcGVjaWFsTWFzdGVyUXVlcnlLZXlzLmluY2x1ZGVzKGtleSkpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYEludmFsaWQga2V5IG5hbWU6ICR7a2V5fWApO1xuICAgIH1cbiAgfSk7XG59O1xuXG4vLyBGaWx0ZXJzIG91dCBhbnkgZGF0YSB0aGF0IHNob3VsZG4ndCBiZSBvbiB0aGlzIFJFU1QtZm9ybWF0dGVkIG9iamVjdC5cbmNvbnN0IGZpbHRlclNlbnNpdGl2ZURhdGEgPSAoXG4gIGlzTWFzdGVyOiBib29sZWFuLFxuICBpc01haW50ZW5hbmNlOiBib29sZWFuLFxuICBhY2xHcm91cDogYW55W10sXG4gIGF1dGg6IGFueSxcbiAgb3BlcmF0aW9uOiBhbnksXG4gIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyIHwgYW55LFxuICBjbGFzc05hbWU6IHN0cmluZyxcbiAgcHJvdGVjdGVkRmllbGRzOiBudWxsIHwgQXJyYXk8YW55PixcbiAgb2JqZWN0OiBhbnksXG4gIHByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0OiA/Ym9vbGVhblxuKSA9PiB7XG4gIGxldCB1c2VySWQgPSBudWxsO1xuICBpZiAoYXV0aCAmJiBhdXRoLnVzZXIpIHsgdXNlcklkID0gYXV0aC51c2VyLmlkOyB9XG5cbiAgLy8gcmVwbGFjZSBwcm90ZWN0ZWRGaWVsZHMgd2hlbiB1c2luZyBwb2ludGVyLXBlcm1pc3Npb25zXG4gIGNvbnN0IHBlcm1zID1cbiAgICBzY2hlbWEgJiYgc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyA/IHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKSA6IHt9O1xuICBpZiAocGVybXMpIHtcbiAgICBjb25zdCBpc1JlYWRPcGVyYXRpb24gPSBbJ2dldCcsICdmaW5kJ10uaW5kZXhPZihvcGVyYXRpb24pID4gLTE7XG5cbiAgICBpZiAoaXNSZWFkT3BlcmF0aW9uICYmIHBlcm1zLnByb3RlY3RlZEZpZWxkcykge1xuICAgICAgLy8gZXh0cmFjdCBwcm90ZWN0ZWRGaWVsZHMgYWRkZWQgd2l0aCB0aGUgcG9pbnRlci1wZXJtaXNzaW9uIHByZWZpeFxuICAgICAgY29uc3QgcHJvdGVjdGVkRmllbGRzUG9pbnRlclBlcm0gPSBPYmplY3Qua2V5cyhwZXJtcy5wcm90ZWN0ZWRGaWVsZHMpXG4gICAgICAgIC5maWx0ZXIoa2V5ID0+IGtleS5zdGFydHNXaXRoKCd1c2VyRmllbGQ6JykpXG4gICAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgICByZXR1cm4geyBrZXk6IGtleS5zdWJzdHJpbmcoMTApLCB2YWx1ZTogcGVybXMucHJvdGVjdGVkRmllbGRzW2tleV0gfTtcbiAgICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG5ld1Byb3RlY3RlZEZpZWxkczogQXJyYXk8c3RyaW5nPltdID0gW107XG4gICAgICBsZXQgb3ZlcnJpZGVQcm90ZWN0ZWRGaWVsZHMgPSBmYWxzZTtcblxuICAgICAgLy8gY2hlY2sgaWYgdGhlIG9iamVjdCBncmFudHMgdGhlIGN1cnJlbnQgdXNlciBhY2Nlc3MgYmFzZWQgb24gdGhlIGV4dHJhY3RlZCBmaWVsZHNcbiAgICAgIHByb3RlY3RlZEZpZWxkc1BvaW50ZXJQZXJtLmZvckVhY2gocG9pbnRlclBlcm0gPT4ge1xuICAgICAgICBsZXQgcG9pbnRlclBlcm1JbmNsdWRlc1VzZXIgPSBmYWxzZTtcbiAgICAgICAgY29uc3QgcmVhZFVzZXJGaWVsZFZhbHVlID0gb2JqZWN0W3BvaW50ZXJQZXJtLmtleV07XG4gICAgICAgIGlmIChyZWFkVXNlckZpZWxkVmFsdWUpIHtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZWFkVXNlckZpZWxkVmFsdWUpKSB7XG4gICAgICAgICAgICBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9IHJlYWRVc2VyRmllbGRWYWx1ZS5zb21lKFxuICAgICAgICAgICAgICB1c2VyID0+IHVzZXIub2JqZWN0SWQgJiYgdXNlci5vYmplY3RJZCA9PT0gdXNlcklkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9XG4gICAgICAgICAgICAgIHJlYWRVc2VyRmllbGRWYWx1ZS5vYmplY3RJZCAmJiByZWFkVXNlckZpZWxkVmFsdWUub2JqZWN0SWQgPT09IHVzZXJJZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocG9pbnRlclBlcm1JbmNsdWRlc1VzZXIpIHtcbiAgICAgICAgICBvdmVycmlkZVByb3RlY3RlZEZpZWxkcyA9IHRydWU7XG4gICAgICAgICAgbmV3UHJvdGVjdGVkRmllbGRzLnB1c2gocG9pbnRlclBlcm0udmFsdWUpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gaWYgYXQgbGVhc3Qgb25lIHBvaW50ZXItcGVybWlzc2lvbiBhZmZlY3RlZCB0aGUgY3VycmVudCB1c2VyXG4gICAgICAvLyBpbnRlcnNlY3QgdnMgcHJvdGVjdGVkRmllbGRzIGZyb20gcHJldmlvdXMgc3RhZ2UgKEBzZWUgYWRkUHJvdGVjdGVkRmllbGRzKVxuICAgICAgLy8gU2V0cyB0aGVvcnkgKGludGVyc2VjdGlvbnMpOiBBIHggKEIgeCBDKSA9PSAoQSB4IEIpIHggQ1xuICAgICAgaWYgKG92ZXJyaWRlUHJvdGVjdGVkRmllbGRzICYmIHByb3RlY3RlZEZpZWxkcykge1xuICAgICAgICBuZXdQcm90ZWN0ZWRGaWVsZHMucHVzaChwcm90ZWN0ZWRGaWVsZHMpO1xuICAgICAgfVxuICAgICAgLy8gaW50ZXJzZWN0IGFsbCBzZXRzIG9mIHByb3RlY3RlZEZpZWxkc1xuICAgICAgbmV3UHJvdGVjdGVkRmllbGRzLmZvckVhY2goZmllbGRzID0+IHtcbiAgICAgICAgaWYgKGZpZWxkcykge1xuICAgICAgICAgIC8vIGlmIHRoZXJlJ3JlIG5vIHByb3RjdGVkRmllbGRzIGJ5IG90aGVyIGNyaXRlcmlhICggaWQgLyByb2xlIC8gYXV0aClcbiAgICAgICAgICAvLyB0aGVuIHdlIG11c3QgaW50ZXJzZWN0IGVhY2ggc2V0IChwZXIgdXNlckZpZWxkKVxuICAgICAgICAgIGlmICghcHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgICAgICBwcm90ZWN0ZWRGaWVsZHMgPSBmaWVsZHM7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IHByb3RlY3RlZEZpZWxkcy5maWx0ZXIodiA9PiBmaWVsZHMuaW5jbHVkZXModikpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgaXNVc2VyQ2xhc3MgPSBjbGFzc05hbWUgPT09ICdfVXNlcic7XG4gIGlmIChpc1VzZXJDbGFzcykge1xuICAgIG9iamVjdC5wYXNzd29yZCA9IG9iamVjdC5faGFzaGVkX3Bhc3N3b3JkO1xuICAgIGRlbGV0ZSBvYmplY3QuX2hhc2hlZF9wYXNzd29yZDtcbiAgICBkZWxldGUgb2JqZWN0LnNlc3Npb25Ub2tlbjtcbiAgfVxuXG4gIGlmIChpc01haW50ZW5hbmNlKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIC8qIHNwZWNpYWwgdHJlYXQgZm9yIHRoZSB1c2VyIGNsYXNzOiBkb24ndCBmaWx0ZXIgcHJvdGVjdGVkRmllbGRzIGlmIGN1cnJlbnRseSBsb2dnZWRpbiB1c2VyIGlzXG4gIHRoZSByZXRyaWV2ZWQgdXNlciwgdW5sZXNzIHByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0IGlzIGZhbHNlICovXG4gIGNvbnN0IGlzT3duZXJFeGVtcHQgPSBwcm90ZWN0ZWRGaWVsZHNPd25lckV4ZW1wdCAhPT0gZmFsc2UgJiYgaXNVc2VyQ2xhc3MgJiYgdXNlcklkICYmIG9iamVjdC5vYmplY3RJZCA9PT0gdXNlcklkO1xuICBpZiAoIWlzT3duZXJFeGVtcHQpIHtcbiAgICBwcm90ZWN0ZWRGaWVsZHMgJiYgcHJvdGVjdGVkRmllbGRzLmZvckVhY2goayA9PiBkZWxldGUgb2JqZWN0W2tdKTtcblxuICAgIC8vIGZpZWxkcyBub3QgcmVxdWVzdGVkIGJ5IGNsaWVudCAoZXhjbHVkZWQpLFxuICAgIC8vIGJ1dCB3ZXJlIG5lZWRlZCB0byBhcHBseSBwcm90ZWN0ZWRGaWVsZHNcbiAgICBwZXJtcz8ucHJvdGVjdGVkRmllbGRzPy50ZW1wb3JhcnlLZXlzPy5mb3JFYWNoKGsgPT4gZGVsZXRlIG9iamVjdFtrXSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGtleSBpbiBvYmplY3QpIHtcbiAgICBpZiAoa2V5LmNoYXJBdCgwKSA9PT0gJ18nKSB7XG4gICAgICBkZWxldGUgb2JqZWN0W2tleV07XG4gICAgfVxuICB9XG5cbiAgaWYgKCFpc1VzZXJDbGFzcyB8fCBpc01hc3Rlcikge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICBpZiAoYWNsR3JvdXAuaW5kZXhPZihvYmplY3Qub2JqZWN0SWQpID4gLTEpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGRlbGV0ZSBvYmplY3QuYXV0aERhdGE7XG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG4vLyBSdW5zIGFuIHVwZGF0ZSBvbiB0aGUgZGF0YWJhc2UuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYW4gb2JqZWN0IHdpdGggdGhlIG5ldyB2YWx1ZXMgZm9yIGZpZWxkXG4vLyBtb2RpZmljYXRpb25zIHRoYXQgZG9uJ3Qga25vdyB0aGVpciByZXN1bHRzIGFoZWFkIG9mIHRpbWUsIGxpa2Vcbi8vICdpbmNyZW1lbnQnLlxuLy8gT3B0aW9uczpcbi8vICAgYWNsOiAgYSBsaXN0IG9mIHN0cmluZ3MuIElmIHRoZSBvYmplY3QgdG8gYmUgdXBkYXRlZCBoYXMgYW4gQUNMLFxuLy8gICAgICAgICBvbmUgb2YgdGhlIHByb3ZpZGVkIHN0cmluZ3MgbXVzdCBwcm92aWRlIHRoZSBjYWxsZXIgd2l0aFxuLy8gICAgICAgICB3cml0ZSBwZXJtaXNzaW9ucy5cbmNvbnN0IHNwZWNpYWxLZXlzRm9yVXBkYXRlID0gT2JqZWN0LmtleXMoaW50ZXJuYWxGaWVsZHMpLmZpbHRlcihrID0+IGludGVybmFsRmllbGRzW2tdLm1hc3RlcldyaXRlKTtcblxuY29uc3QgaXNTcGVjaWFsVXBkYXRlS2V5ID0ga2V5ID0+IHtcbiAgcmV0dXJuIHNwZWNpYWxLZXlzRm9yVXBkYXRlLmluZGV4T2Yoa2V5KSA+PSAwO1xufTtcblxuZnVuY3Rpb24gam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSkge1xuICByZXR1cm4gYF9Kb2luOiR7a2V5fToke2NsYXNzTmFtZX1gO1xufVxuXG5jb25zdCBmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlID0gb2JqZWN0ID0+IHtcbiAgZm9yIChjb25zdCBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKG9iamVjdFtrZXldICYmIG9iamVjdFtrZXldLl9fb3ApIHtcbiAgICAgIHN3aXRjaCAob2JqZWN0W2tleV0uX19vcCkge1xuICAgICAgICBjYXNlICdJbmNyZW1lbnQnOlxuICAgICAgICAgIGlmICh0eXBlb2Ygb2JqZWN0W2tleV0uYW1vdW50ICE9PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5hbW91bnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ1NldE9uSW5zZXJ0JzpcbiAgICAgICAgICBvYmplY3Rba2V5XSA9IG9iamVjdFtrZXldLmFtb3VudDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnQWRkJzpcbiAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkob2JqZWN0W2tleV0ub2JqZWN0cykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5Jyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gb2JqZWN0W2tleV0ub2JqZWN0cztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnQWRkVW5pcXVlJzpcbiAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkob2JqZWN0W2tleV0ub2JqZWN0cykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5Jyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gb2JqZWN0W2tleV0ub2JqZWN0cztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUmVtb3ZlJzpcbiAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkob2JqZWN0W2tleV0ub2JqZWN0cykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5Jyk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gW107XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0RlbGV0ZSc6XG4gICAgICAgICAgZGVsZXRlIG9iamVjdFtrZXldO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkNPTU1BTkRfVU5BVkFJTEFCTEUsXG4gICAgICAgICAgICBgVGhlICR7b2JqZWN0W2tleV0uX19vcH0gb3BlcmF0b3IgaXMgbm90IHN1cHBvcnRlZCB5ZXQuYFxuICAgICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1BdXRoRGF0YSA9IChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSA9PiB7XG4gIGlmIChvYmplY3QuYXV0aERhdGEgJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgT2JqZWN0LmtleXMob2JqZWN0LmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IG9iamVjdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICBjb25zdCBmaWVsZE5hbWUgPSBgX2F1dGhfZGF0YV8ke3Byb3ZpZGVyfWA7XG4gICAgICBpZiAocHJvdmlkZXJEYXRhID09IG51bGwpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX19vcDogJ0RlbGV0ZScsXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHByb3ZpZGVyRGF0YTtcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdID0geyB0eXBlOiAnT2JqZWN0JyB9O1xuICAgICAgfVxuICAgIH0pO1xuICAgIGRlbGV0ZSBvYmplY3QuYXV0aERhdGE7XG4gIH1cbn07XG4vLyBUcmFuc2Zvcm1zIGEgRGF0YWJhc2UgZm9ybWF0IEFDTCB0byBhIFJFU1QgQVBJIGZvcm1hdCBBQ0xcbmNvbnN0IHVudHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgX3JwZXJtLCBfd3Blcm0sIC4uLm91dHB1dCB9KSA9PiB7XG4gIGlmIChfcnBlcm0gfHwgX3dwZXJtKSB7XG4gICAgb3V0cHV0LkFDTCA9IHt9O1xuXG4gICAgLy8gT3duLXByb3BlcnR5IGNoZWNrIHNvIGFuIGluaGVyaXRlZCBtZW1iZXIgbmFtZSBpcyBuZXZlciByZWFkIGFzIHRoZSBjb250YWluZXJcbiAgICAoX3JwZXJtIHx8IFtdKS5mb3JFYWNoKGVudHJ5ID0+IHtcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihvdXRwdXQuQUNMLCBlbnRyeSkpIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV0gPSB7IHJlYWQ6IHRydWUgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldWydyZWFkJ10gPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgKF93cGVybSB8fCBbXSkuZm9yRWFjaChlbnRyeSA9PiB7XG4gICAgICBpZiAoIU9iamVjdC5oYXNPd24ob3V0cHV0LkFDTCwgZW50cnkpKSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldID0geyB3cml0ZTogdHJ1ZSB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV1bJ3dyaXRlJ10gPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBvdXRwdXQ7XG59O1xuXG4vKipcbiAqIFdoZW4gcXVlcnlpbmcsIHRoZSBmaWVsZE5hbWUgbWF5IGJlIGNvbXBvdW5kLCBleHRyYWN0IHRoZSByb290IGZpZWxkTmFtZVxuICogICAgIGB0ZW1wZXJhdHVyZS5jZWxzaXVzYCBiZWNvbWVzIGB0ZW1wZXJhdHVyZWBcbiAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgdGhhdCBtYXkgYmUgYSBjb21wb3VuZCBmaWVsZCBuYW1lXG4gKiBAcmV0dXJucyB7c3RyaW5nfSB0aGUgcm9vdCBuYW1lIG9mIHRoZSBmaWVsZFxuICovXG5jb25zdCBnZXRSb290RmllbGROYW1lID0gKGZpZWxkTmFtZTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgcmV0dXJuIGZpZWxkTmFtZS5zcGxpdCgnLicpWzBdO1xufTtcblxuY29uc3QgcmVsYXRpb25TY2hlbWEgPSB7XG4gIGZpZWxkczogeyByZWxhdGVkSWQ6IHsgdHlwZTogJ1N0cmluZycgfSwgb3duaW5nSWQ6IHsgdHlwZTogJ1N0cmluZycgfSB9LFxufTtcblxuY29uc3QgY29udmVydEVtYWlsVG9Mb3dlcmNhc2UgPSAob2JqZWN0LCBjbGFzc05hbWUsIG9wdGlvbnMpID0+IHtcbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19Vc2VyJyAmJiBvcHRpb25zLmNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKSB7XG4gICAgaWYgKHR5cGVvZiBvYmplY3RbJ2VtYWlsJ10gPT09ICdzdHJpbmcnKSB7XG4gICAgICBvYmplY3RbJ2VtYWlsJ10gPSBvYmplY3RbJ2VtYWlsJ10udG9Mb3dlckNhc2UoKTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IGNvbnZlcnRVc2VybmFtZVRvTG93ZXJjYXNlID0gKG9iamVjdCwgY2xhc3NOYW1lLCBvcHRpb25zKSA9PiB7XG4gIGlmIChjbGFzc05hbWUgPT09ICdfVXNlcicgJiYgb3B0aW9ucy5jb252ZXJ0VXNlcm5hbWVUb0xvd2VyY2FzZSkge1xuICAgIGlmICh0eXBlb2Ygb2JqZWN0Wyd1c2VybmFtZSddID09PSAnc3RyaW5nJykge1xuICAgICAgb2JqZWN0Wyd1c2VybmFtZSddID0gb2JqZWN0Wyd1c2VybmFtZSddLnRvTG93ZXJDYXNlKCk7XG4gICAgfVxuICB9XG59O1xuXG5jbGFzcyBEYXRhYmFzZUNvbnRyb2xsZXIge1xuICBhZGFwdGVyOiBTdG9yYWdlQWRhcHRlcjtcbiAgc2NoZW1hQ2FjaGU6IGFueTtcbiAgc2NoZW1hUHJvbWlzZTogP1Byb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPjtcbiAgX3RyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55O1xuICBvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnM7XG4gIGlkZW1wb3RlbmN5T3B0aW9uczogYW55O1xuXG4gIGNvbnN0cnVjdG9yKGFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyLCBvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgICB0aGlzLmFkYXB0ZXIgPSBhZGFwdGVyO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgdGhpcy5pZGVtcG90ZW5jeU9wdGlvbnMgPSB0aGlzLm9wdGlvbnMuaWRlbXBvdGVuY3lPcHRpb25zIHx8IHt9O1xuICAgIC8vIFByZXZlbnQgbXV0YWJsZSB0aGlzLnNjaGVtYSwgb3RoZXJ3aXNlIG9uZSByZXF1ZXN0IGNvdWxkIHVzZVxuICAgIC8vIG11bHRpcGxlIHNjaGVtYXMsIHNvIGluc3RlYWQgdXNlIGxvYWRTY2hlbWEgdG8gZ2V0IGEgc2NoZW1hLlxuICAgIHRoaXMuc2NoZW1hUHJvbWlzZSA9IG51bGw7XG4gICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSBudWxsO1xuICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uUGVuZGluZyA9IGZhbHNlO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gIH1cblxuICBjb2xsZWN0aW9uRXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jbGFzc0V4aXN0cyhjbGFzc05hbWUpO1xuICB9XG5cbiAgcHVyZ2VDb2xsZWN0aW9uKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSkpXG4gICAgICAudGhlbihzY2hlbWEgPT4gdGhpcy5hZGFwdGVyLmRlbGV0ZU9iamVjdHNCeVF1ZXJ5KGNsYXNzTmFtZSwgc2NoZW1hLCB7fSkpO1xuICB9XG5cbiAgdmFsaWRhdGVDbGFzc05hbWUoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIVNjaGVtYUNvbnRyb2xsZXIuY2xhc3NOYW1lSXNWYWxpZChjbGFzc05hbWUpKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUUsICdpbnZhbGlkIGNsYXNzTmFtZTogJyArIGNsYXNzTmFtZSlcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIHNjaGVtYUNvbnRyb2xsZXIuXG4gIGxvYWRTY2hlbWEoXG4gICAgb3B0aW9uczogTG9hZFNjaGVtYU9wdGlvbnMgPSB7IGNsZWFyQ2FjaGU6IGZhbHNlIH1cbiAgKTogUHJvbWlzZTxTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXI+IHtcbiAgICBpZiAodGhpcy5zY2hlbWFQcm9taXNlICE9IG51bGwpIHtcbiAgICAgIHJldHVybiB0aGlzLnNjaGVtYVByb21pc2U7XG4gICAgfVxuICAgIHRoaXMuc2NoZW1hUHJvbWlzZSA9IFNjaGVtYUNvbnRyb2xsZXIubG9hZCh0aGlzLmFkYXB0ZXIsIG9wdGlvbnMpO1xuICAgIHRoaXMuc2NoZW1hUHJvbWlzZS50aGVuKFxuICAgICAgKCkgPT4gZGVsZXRlIHRoaXMuc2NoZW1hUHJvbWlzZSxcbiAgICAgICgpID0+IGRlbGV0ZSB0aGlzLnNjaGVtYVByb21pc2VcbiAgICApO1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEob3B0aW9ucyk7XG4gIH1cblxuICBsb2FkU2NoZW1hSWZOZWVkZWQoXG4gICAgc2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9XG4gICk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPiB7XG4gICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXIgPyBQcm9taXNlLnJlc29sdmUoc2NoZW1hQ29udHJvbGxlcikgOiB0aGlzLmxvYWRTY2hlbWEob3B0aW9ucyk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgdGhlIGNsYXNzbmFtZSB0aGF0IGlzIHJlbGF0ZWQgdG8gdGhlIGdpdmVuXG4gIC8vIGNsYXNzbmFtZSB0aHJvdWdoIHRoZSBrZXkuXG4gIC8vIFRPRE86IG1ha2UgdGhpcyBub3QgaW4gdGhlIERhdGFiYXNlQ29udHJvbGxlciBpbnRlcmZhY2VcbiAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXkoY2xhc3NOYW1lOiBzdHJpbmcsIGtleTogc3RyaW5nKTogUHJvbWlzZTw/c3RyaW5nPiB7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgIHZhciB0ID0gc2NoZW1hLmdldEV4cGVjdGVkVHlwZShjbGFzc05hbWUsIGtleSk7XG4gICAgICBpZiAodCAhPSBudWxsICYmIHR5cGVvZiB0ICE9PSAnc3RyaW5nJyAmJiB0LnR5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgcmV0dXJuIHQudGFyZ2V0Q2xhc3M7XG4gICAgICB9XG4gICAgICByZXR1cm4gY2xhc3NOYW1lO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVXNlcyB0aGUgc2NoZW1hIHRvIHZhbGlkYXRlIHRoZSBvYmplY3QgKFJFU1QgQVBJIGZvcm1hdCkuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gdGhlIG5ldyBzY2hlbWEuXG4gIC8vIFRoaXMgZG9lcyBub3QgdXBkYXRlIHRoaXMuc2NoZW1hLCBiZWNhdXNlIGluIGEgc2l0dWF0aW9uIGxpa2UgYVxuICAvLyBiYXRjaCByZXF1ZXN0LCB0aGF0IGNvdWxkIGNvbmZ1c2Ugb3RoZXIgdXNlcnMgb2YgdGhlIHNjaGVtYS5cbiAgdmFsaWRhdGVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgb2JqZWN0OiBhbnksXG4gICAgcXVlcnk6IGFueSxcbiAgICBydW5PcHRpb25zOiBRdWVyeU9wdGlvbnMsXG4gICAgbWFpbnRlbmFuY2U6IGJvb2xlYW5cbiAgKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgbGV0IHNjaGVtYTtcbiAgICBjb25zdCBhY2wgPSBydW5PcHRpb25zLmFjbDtcbiAgICBjb25zdCBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cDogc3RyaW5nW10gPSBhY2wgfHwgW107XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYSgpXG4gICAgICAudGhlbihzID0+IHtcbiAgICAgICAgc2NoZW1hID0gcztcbiAgICAgICAgaWYgKGlzTWFzdGVyKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmNhbkFkZEZpZWxkKHNjaGVtYSwgY2xhc3NOYW1lLCBvYmplY3QsIGFjbEdyb3VwLCBydW5PcHRpb25zKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBzY2hlbWEudmFsaWRhdGVPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHF1ZXJ5LCBtYWludGVuYW5jZSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBVcGRhdGVzIG9iamVjdHMgaW4gdGhlIGRhdGFiYXNlIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIHF1ZXJ5LlxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9uc1xuICAgKiBAcGFyYW0ge2Jvb2xlYW59IFtvcHRpb25zLm1hbnk9ZmFsc2VdIFdoZW4gdHJ1ZSwgdXBkYXRlcyBhbGwgbWF0Y2hpbmcgZG9jdW1lbnRzXG4gICAqICAgYW5kIHJldHVybnMgYHsgbWF0Y2hlZENvdW50LCBtb2RpZmllZENvdW50IH1gIHdoZXJlIHZhbHVlcyBhcmUgbnVtYmVycyBpZiB0aGVcbiAgICogICBzdG9yYWdlIGFkYXB0ZXIgc3VwcG9ydHMgYFVwZGF0ZU1hbnlSZXN1bHRgLCBvciBgdW5kZWZpbmVkYCBvdGhlcndpc2UuXG4gICAqL1xuICB1cGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB7IGFjbCwgbWFueSwgdXBzZXJ0LCBhZGRzRmllbGQgfTogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHNraXBTYW5pdGl6YXRpb246IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLm9wdGlvbnMsIHVwZGF0ZSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYCR7ZXJyb3J9YCkpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB2YWxpZGF0ZUZpbGVVcmxzSW5PYmplY3QgfSA9IHJlcXVpcmUoJy4uL0ZpbGVVcmxWYWxpZGF0b3InKTtcbiAgICAgIHZhbGlkYXRlRmlsZVVybHNJbk9iamVjdCh1cGRhdGUsIHRoaXMub3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yID8gZXJyb3IgOiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCBlcnJvci5tZXNzYWdlIHx8IGVycm9yKSk7XG4gICAgfVxuICAgIGNvbnN0IG9yaWdpbmFsUXVlcnkgPSBxdWVyeTtcbiAgICBjb25zdCBvcmlnaW5hbFVwZGF0ZSA9IHVwZGF0ZTtcbiAgICAvLyBNYWtlIGEgY29weSBvZiB0aGUgb2JqZWN0LCBzbyB3ZSBkb24ndCBtdXRhdGUgdGhlIGluY29taW5nIGRhdGEuXG4gICAgdXBkYXRlID0gc3RydWN0dXJlZENsb25lKHVwZGF0ZSk7XG4gICAgdmFyIHJlbGF0aW9uVXBkYXRlcyA9IFtdO1xuICAgIHZhciBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZCh2YWxpZFNjaGVtYUNvbnRyb2xsZXIpLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiB7XG4gICAgICByZXR1cm4gKGlzTWFzdGVyXG4gICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgOiBzY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihjbGFzc05hbWUsIGFjbEdyb3VwLCAndXBkYXRlJylcbiAgICAgIClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHJlbGF0aW9uVXBkYXRlcyA9IHRoaXMuY29sbGVjdFJlbGF0aW9uVXBkYXRlcyhjbGFzc05hbWUsIG9yaWdpbmFsUXVlcnkub2JqZWN0SWQsIHVwZGF0ZSk7XG4gICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAndXBkYXRlJyxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoYWRkc0ZpZWxkKSB7XG4gICAgICAgICAgICAgIHF1ZXJ5ID0ge1xuICAgICAgICAgICAgICAgICRhbmQ6IFtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgJ2FkZEZpZWxkJyxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGFjbCkge1xuICAgICAgICAgICAgcXVlcnkgPSBhZGRXcml0ZUFDTChxdWVyeSwgYWNsKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdmFsaWRhdGVRdWVyeShxdWVyeSwgaXNNYXN0ZXIsIGZhbHNlLCB0cnVlLCB0aGlzLm9wdGlvbnMpO1xuICAgICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgICAuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSwgdHJ1ZSlcbiAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgIC8vIElmIHRoZSBzY2hlbWEgZG9lc24ndCBleGlzdCwgcHJldGVuZCBpdCBleGlzdHMgd2l0aCBubyBmaWVsZHMuIFRoaXMgYmVoYXZpb3JcbiAgICAgICAgICAgICAgLy8gd2lsbCBsaWtlbHkgbmVlZCByZXZpc2l0aW5nLlxuICAgICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICAgICAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lLm1hdGNoKC9eYXV0aERhdGFcXC4vKSkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lIGZvciB1cGRhdGU6ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lLCBjbGFzc05hbWUpICYmXG4gICAgICAgICAgICAgICAgICAhaXNTcGVjaWFsVXBkYXRlS2V5KHJvb3RGaWVsZE5hbWUpXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWUgZm9yIHVwZGF0ZTogJHtmaWVsZE5hbWV9YFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHVwZGF0ZU9wZXJhdGlvbiBpbiB1cGRhdGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICB1cGRhdGVbdXBkYXRlT3BlcmF0aW9uXSAmJlxuICAgICAgICAgICAgICAgICAgdHlwZW9mIHVwZGF0ZVt1cGRhdGVPcGVyYXRpb25dID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXModXBkYXRlW3VwZGF0ZU9wZXJhdGlvbl0pLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgIGlubmVyS2V5ID0+IGlubmVyS2V5LmluY2x1ZGVzKCckJykgfHwgaW5uZXJLZXkuaW5jbHVkZXMoJy4nKVxuICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICAgICAgICAgICAgICAgIFwiTmVzdGVkIGtleXMgc2hvdWxkIG5vdCBjb250YWluIHRoZSAnJCcgb3IgJy4nIGNoYXJhY3RlcnNcIlxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdXBkYXRlID0gdHJhbnNmb3JtT2JqZWN0QUNMKHVwZGF0ZSk7XG4gICAgICAgICAgICAgIGNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKHVwZGF0ZSwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgICAgICAgICAgICBjb252ZXJ0VXNlcm5hbWVUb0xvd2VyY2FzZSh1cGRhdGUsIGNsYXNzTmFtZSwgdGhpcy5vcHRpb25zKTtcbiAgICAgICAgICAgICAgdHJhbnNmb3JtQXV0aERhdGEoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmZpbmQoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCB7IHJlYWRQcmVmZXJlbmNlOiAncHJpbWFyeScgfSkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKCFyZXN1bHQgfHwgIXJlc3VsdC5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChtYW55KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci51cGRhdGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgdXBkYXRlLFxuICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKHVwc2VydCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5maW5kT25lQW5kVXBkYXRlKFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigocmVzdWx0OiBhbnkpID0+IHtcbiAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsaWRhdGVPbmx5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICBvcmlnaW5hbFF1ZXJ5Lm9iamVjdElkLFxuICAgICAgICAgICAgdXBkYXRlLFxuICAgICAgICAgICAgcmVsYXRpb25VcGRhdGVzXG4gICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgaWYgKHNraXBTYW5pdGl6YXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKG1hbnkpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIG1hdGNoZWRDb3VudDogdHlwZW9mIHJlc3VsdD8ubWF0Y2hlZENvdW50ID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgID8gcmVzdWx0Lm1hdGNoZWRDb3VudFxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICBtb2RpZmllZENvdW50OiB0eXBlb2YgcmVzdWx0Py5tb2RpZmllZENvdW50ID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgICAgID8gcmVzdWx0Lm1vZGlmaWVkQ291bnRcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aGlzLl9zYW5pdGl6ZURhdGFiYXNlUmVzdWx0KG9yaWdpbmFsVXBkYXRlLCByZXN1bHQpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIENvbGxlY3QgYWxsIHJlbGF0aW9uLXVwZGF0aW5nIG9wZXJhdGlvbnMgZnJvbSBhIFJFU1QtZm9ybWF0IHVwZGF0ZS5cbiAgLy8gUmV0dXJucyBhIGxpc3Qgb2YgYWxsIHJlbGF0aW9uIHVwZGF0ZXMgdG8gcGVyZm9ybVxuICAvLyBUaGlzIG11dGF0ZXMgdXBkYXRlLlxuICBjb2xsZWN0UmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZTogc3RyaW5nLCBvYmplY3RJZDogP3N0cmluZywgdXBkYXRlOiBhbnkpIHtcbiAgICB2YXIgb3BzID0gW107XG4gICAgdmFyIGRlbGV0ZU1lID0gW107XG4gICAgb2JqZWN0SWQgPSB1cGRhdGUub2JqZWN0SWQgfHwgb2JqZWN0SWQ7XG5cbiAgICB2YXIgcHJvY2VzcyA9IChvcCwga2V5KSA9PiB7XG4gICAgICBpZiAoIW9wKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChvcC5fX29wID09ICdBZGRSZWxhdGlvbicpIHtcbiAgICAgICAgb3BzLnB1c2goeyBrZXksIG9wIH0pO1xuICAgICAgICBkZWxldGVNZS5wdXNoKGtleSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdSZW1vdmVSZWxhdGlvbicpIHtcbiAgICAgICAgb3BzLnB1c2goeyBrZXksIG9wIH0pO1xuICAgICAgICBkZWxldGVNZS5wdXNoKGtleSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdCYXRjaCcpIHtcbiAgICAgICAgZm9yICh2YXIgeCBvZiBvcC5vcHMpIHtcbiAgICAgICAgICBwcm9jZXNzKHgsIGtleSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuXG4gICAgZm9yIChjb25zdCBrZXkgaW4gdXBkYXRlKSB7XG4gICAgICBwcm9jZXNzKHVwZGF0ZVtrZXldLCBrZXkpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBkZWxldGVNZSkge1xuICAgICAgZGVsZXRlIHVwZGF0ZVtrZXldO1xuICAgIH1cbiAgICByZXR1cm4gb3BzO1xuICB9XG5cbiAgLy8gUHJvY2Vzc2VzIHJlbGF0aW9uLXVwZGF0aW5nIG9wZXJhdGlvbnMgZnJvbSBhIFJFU1QtZm9ybWF0IHVwZGF0ZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGFsbCB1cGRhdGVzIGhhdmUgYmVlbiBwZXJmb3JtZWRcbiAgaGFuZGxlUmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZTogc3RyaW5nLCBvYmplY3RJZDogc3RyaW5nLCB1cGRhdGU6IGFueSwgb3BzOiBhbnkpIHtcbiAgICB2YXIgcGVuZGluZyA9IFtdO1xuICAgIG9iamVjdElkID0gdXBkYXRlLm9iamVjdElkIHx8IG9iamVjdElkO1xuICAgIG9wcy5mb3JFYWNoKCh7IGtleSwgb3AgfSkgPT4ge1xuICAgICAgaWYgKCFvcCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAob3AuX19vcCA9PSAnQWRkUmVsYXRpb24nKSB7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqZWN0IG9mIG9wLm9iamVjdHMpIHtcbiAgICAgICAgICBwZW5kaW5nLnB1c2godGhpcy5hZGRSZWxhdGlvbihrZXksIGNsYXNzTmFtZSwgb2JqZWN0SWQsIG9iamVjdC5vYmplY3RJZCkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5fX29wID09ICdSZW1vdmVSZWxhdGlvbicpIHtcbiAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2Ygb3Aub2JqZWN0cykge1xuICAgICAgICAgIHBlbmRpbmcucHVzaCh0aGlzLnJlbW92ZVJlbGF0aW9uKGtleSwgY2xhc3NOYW1lLCBvYmplY3RJZCwgb2JqZWN0Lm9iamVjdElkKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChwZW5kaW5nKTtcbiAgfVxuXG4gIC8vIEFkZHMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBhZGQgd2FzIHN1Y2Nlc3NmdWwuXG4gIGFkZFJlbGF0aW9uKGtleTogc3RyaW5nLCBmcm9tQ2xhc3NOYW1lOiBzdHJpbmcsIGZyb21JZDogc3RyaW5nLCB0b0lkOiBzdHJpbmcpIHtcbiAgICBjb25zdCBkb2MgPSB7XG4gICAgICByZWxhdGVkSWQ6IHRvSWQsXG4gICAgICBvd25pbmdJZDogZnJvbUlkLFxuICAgIH07XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci51cHNlcnRPbmVPYmplY3QoXG4gICAgICBgX0pvaW46JHtrZXl9OiR7ZnJvbUNsYXNzTmFtZX1gLFxuICAgICAgcmVsYXRpb25TY2hlbWEsXG4gICAgICBkb2MsXG4gICAgICBkb2MsXG4gICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICk7XG4gIH1cblxuICAvLyBSZW1vdmVzIGEgcmVsYXRpb24uXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgc3VjY2Vzc2Z1bGx5IGlmZiB0aGUgcmVtb3ZlIHdhc1xuICAvLyBzdWNjZXNzZnVsLlxuICByZW1vdmVSZWxhdGlvbihrZXk6IHN0cmluZywgZnJvbUNsYXNzTmFtZTogc3RyaW5nLCBmcm9tSWQ6IHN0cmluZywgdG9JZDogc3RyaW5nKSB7XG4gICAgdmFyIGRvYyA9IHtcbiAgICAgIHJlbGF0ZWRJZDogdG9JZCxcbiAgICAgIG93bmluZ0lkOiBmcm9tSWQsXG4gICAgfTtcbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgICAgIGBfSm9pbjoke2tleX06JHtmcm9tQ2xhc3NOYW1lfWAsXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICBkb2MsXG4gICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBXZSBkb24ndCBjYXJlIGlmIHRoZXkgdHJ5IHRvIGRlbGV0ZSBhIG5vbi1leGlzdGVudCByZWxhdGlvbi5cbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gUmVtb3ZlcyBvYmplY3RzIG1hdGNoZXMgdGhpcyBxdWVyeSBmcm9tIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBvYmplY3Qgd2FzXG4gIC8vIGRlbGV0ZWQuXG4gIC8vIE9wdGlvbnM6XG4gIC8vICAgYWNsOiAgYSBsaXN0IG9mIHN0cmluZ3MuIElmIHRoZSBvYmplY3QgdG8gYmUgdXBkYXRlZCBoYXMgYW4gQUNMLFxuICAvLyAgICAgICAgIG9uZSBvZiB0aGUgcHJvdmlkZWQgc3RyaW5ncyBtdXN0IHByb3ZpZGUgdGhlIGNhbGxlciB3aXRoXG4gIC8vICAgICAgICAgd3JpdGUgcGVybWlzc2lvbnMuXG4gIGRlc3Ryb3koXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB7IGFjbCB9OiBRdWVyeU9wdGlvbnMgPSB7fSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWNsR3JvdXAgPSBhY2wgfHwgW107XG5cbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hSWZOZWVkZWQodmFsaWRTY2hlbWFDb250cm9sbGVyKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICA/IFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2RlbGV0ZScpXG4gICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAnZGVsZXRlJyxcbiAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVsZXRlIGJ5IHF1ZXJ5XG4gICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpO1xuICAgICAgICB9XG4gICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnksIGlzTWFzdGVyLCBmYWxzZSwgZmFsc2UsIHRoaXMub3B0aW9ucyk7XG4gICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAgIC8vIElmIHRoZSBzY2hlbWEgZG9lc24ndCBleGlzdCwgcHJldGVuZCBpdCBleGlzdHMgd2l0aCBubyBmaWVsZHMuIFRoaXMgYmVoYXZpb3JcbiAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocGFyc2VGb3JtYXRTY2hlbWEgPT5cbiAgICAgICAgICAgIHRoaXMuYWRhcHRlci5kZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBwYXJzZUZvcm1hdFNjaGVtYSxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAvLyBXaGVuIGRlbGV0aW5nIHNlc3Npb25zIHdoaWxlIGNoYW5naW5nIHBhc3N3b3JkcywgZG9uJ3QgdGhyb3cgYW4gZXJyb3IgaWYgdGhleSBkb24ndCBoYXZlIGFueSBzZXNzaW9ucy5cbiAgICAgICAgICAgIGlmIChjbGFzc05hbWUgPT09ICdfU2Vzc2lvbicgJiYgZXJyb3IuY29kZSA9PT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBJbnNlcnRzIGFuIG9iamVjdCBpbnRvIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBvYmplY3Qgc2F2ZWQuXG4gIGNyZWF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICB7IGFjbCB9OiBRdWVyeU9wdGlvbnMgPSB7fSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHRyeSB7XG4gICAgICBVdGlscy5jaGVja1Byb2hpYml0ZWRLZXl3b3Jkcyh0aGlzLm9wdGlvbnMsIG9iamVjdCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYCR7ZXJyb3J9YCkpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB2YWxpZGF0ZUZpbGVVcmxzSW5PYmplY3QgfSA9IHJlcXVpcmUoJy4uL0ZpbGVVcmxWYWxpZGF0b3InKTtcbiAgICAgIHZhbGlkYXRlRmlsZVVybHNJbk9iamVjdChvYmplY3QsIHRoaXMub3B0aW9ucyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yID8gZXJyb3IgOiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRklMRV9TQVZFX0VSUk9SLCBlcnJvci5tZXNzYWdlIHx8IGVycm9yKSk7XG4gICAgfVxuICAgIC8vIE1ha2UgYSBjb3B5IG9mIHRoZSBvYmplY3QsIHNvIHdlIGRvbid0IG11dGF0ZSB0aGUgaW5jb21pbmcgZGF0YS5cbiAgICBjb25zdCBvcmlnaW5hbE9iamVjdCA9IG9iamVjdDtcbiAgICBvYmplY3QgPSB0cmFuc2Zvcm1PYmplY3RBQ0wob2JqZWN0KTtcblxuICAgIGNvbnZlcnRFbWFpbFRvTG93ZXJjYXNlKG9iamVjdCwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgIGNvbnZlcnRVc2VybmFtZVRvTG93ZXJjYXNlKG9iamVjdCwgY2xhc3NOYW1lLCB0aGlzLm9wdGlvbnMpO1xuICAgIG9iamVjdC5jcmVhdGVkQXQgPSB7IGlzbzogb2JqZWN0LmNyZWF0ZWRBdCwgX190eXBlOiAnRGF0ZScgfTtcbiAgICBvYmplY3QudXBkYXRlZEF0ID0geyBpc286IG9iamVjdC51cGRhdGVkQXQsIF9fdHlwZTogJ0RhdGUnIH07XG5cbiAgICB2YXIgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICB2YXIgYWNsR3JvdXAgPSBhY2wgfHwgW107XG4gICAgY29uc3QgcmVsYXRpb25VcGRhdGVzID0gdGhpcy5jb2xsZWN0UmVsYXRpb25VcGRhdGVzKGNsYXNzTmFtZSwgbnVsbCwgb2JqZWN0KTtcblxuICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdjcmVhdGUnKVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4oKCkgPT4gc2NoZW1hQ29udHJvbGxlci5lbmZvcmNlQ2xhc3NFeGlzdHMoY2xhc3NOYW1lKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgICAgIGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUob2JqZWN0KTtcbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jcmVhdGVPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgU2NoZW1hQ29udHJvbGxlci5jb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hKHNjaGVtYSksXG4gICAgICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICByZXR1cm4gb3JpZ2luYWxPYmplY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0Lm9iamVjdElkLFxuICAgICAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3Nhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdC5vcHNbMF0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNhbkFkZEZpZWxkKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIGFjbEdyb3VwOiBzdHJpbmdbXSxcbiAgICBydW5PcHRpb25zOiBRdWVyeU9wdGlvbnNcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2xhc3NTY2hlbWEgPSBzY2hlbWEuc2NoZW1hRGF0YVtjbGFzc05hbWVdO1xuICAgIGlmICghY2xhc3NTY2hlbWEpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMob2JqZWN0KTtcbiAgICBjb25zdCBzY2hlbWFGaWVsZHMgPSBPYmplY3Qua2V5cyhjbGFzc1NjaGVtYS5maWVsZHMpO1xuICAgIGNvbnN0IG5ld0tleXMgPSBmaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIC8vIFNraXAgZmllbGRzIHRoYXQgYXJlIHVuc2V0XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkXSAmJiBvYmplY3RbZmllbGRdLl9fb3AgJiYgb2JqZWN0W2ZpZWxkXS5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2NoZW1hRmllbGRzLmluZGV4T2YoZ2V0Um9vdEZpZWxkTmFtZShmaWVsZCkpIDwgMDtcbiAgICB9KTtcbiAgICBpZiAobmV3S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBhZGRzIGEgbWFya2VyIHRoYXQgbmV3IGZpZWxkIGlzIGJlaW5nIGFkZGluZyBkdXJpbmcgdXBkYXRlXG4gICAgICBydW5PcHRpb25zLmFkZHNGaWVsZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IGFjdGlvbiA9IHJ1bk9wdGlvbnMuYWN0aW9uO1xuICAgICAgcmV0dXJuIHNjaGVtYS52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2FkZEZpZWxkJywgYWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gV29uJ3QgZGVsZXRlIGNvbGxlY3Rpb25zIGluIHRoZSBzeXN0ZW0gbmFtZXNwYWNlXG4gIC8qKlxuICAgKiBEZWxldGUgYWxsIGNsYXNzZXMgYW5kIGNsZWFycyB0aGUgc2NoZW1hIGNhY2hlXG4gICAqXG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gZmFzdCBzZXQgdG8gdHJ1ZSBpZiBpdCdzIG9rIHRvIGp1c3QgZGVsZXRlIHJvd3MgYW5kIG5vdCBpbmRleGVzXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fSB3aGVuIHRoZSBkZWxldGlvbnMgY29tcGxldGVzXG4gICAqL1xuICBkZWxldGVFdmVyeXRoaW5nKGZhc3Q6IGJvb2xlYW4gPSBmYWxzZSk6IFByb21pc2U8YW55PiB7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gbnVsbDtcbiAgICBTY2hlbWFDYWNoZS5jbGVhcigpO1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGVsZXRlQWxsQ2xhc3NlcyhmYXN0KTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2YgcmVsYXRlZCBpZHMgZ2l2ZW4gYW4gb3duaW5nIGlkLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgcmVsYXRlZElkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBrZXk6IHN0cmluZyxcbiAgICBvd25pbmdJZDogc3RyaW5nLFxuICAgIHF1ZXJ5T3B0aW9uczogUXVlcnlPcHRpb25zXG4gICk6IFByb21pc2U8QXJyYXk8c3RyaW5nPj4ge1xuICAgIGNvbnN0IHsgc2tpcCwgbGltaXQsIHNvcnQgfSA9IHF1ZXJ5T3B0aW9ucztcbiAgICBjb25zdCBmaW5kT3B0aW9ucyA9IHt9O1xuICAgIGlmIChzb3J0ICYmIHNvcnQuY3JlYXRlZEF0ICYmIHRoaXMuYWRhcHRlci5jYW5Tb3J0T25Kb2luVGFibGVzKSB7XG4gICAgICBmaW5kT3B0aW9ucy5zb3J0ID0geyBfaWQ6IHNvcnQuY3JlYXRlZEF0IH07XG4gICAgICBmaW5kT3B0aW9ucy5saW1pdCA9IGxpbWl0O1xuICAgICAgZmluZE9wdGlvbnMuc2tpcCA9IHNraXA7XG4gICAgICBxdWVyeU9wdGlvbnMuc2tpcCA9IDA7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5maW5kKGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLCByZWxhdGlvblNjaGVtYSwgeyBvd25pbmdJZCB9LCBmaW5kT3B0aW9ucylcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4gcmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5yZWxhdGVkSWQpKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIGxpc3Qgb2Ygb3duaW5nIGlkcyBnaXZlbiBzb21lIHJlbGF0ZWQgaWRzLlxuICAvLyBjbGFzc05hbWUgaGVyZSBpcyB0aGUgb3duaW5nIGNsYXNzTmFtZS5cbiAgb3duaW5nSWRzKGNsYXNzTmFtZTogc3RyaW5nLCBrZXk6IHN0cmluZywgcmVsYXRlZElkczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgLmZpbmQoXG4gICAgICAgIGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLFxuICAgICAgICByZWxhdGlvblNjaGVtYSxcbiAgICAgICAgeyByZWxhdGVkSWQ6IHsgJGluOiByZWxhdGVkSWRzIH0gfSxcbiAgICAgICAgeyBrZXlzOiBbJ293bmluZ0lkJ10gfVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiByZXN1bHRzLm1hcChyZXN1bHQgPT4gcmVzdWx0Lm93bmluZ0lkKSk7XG4gIH1cblxuICAvLyBNb2RpZmllcyBxdWVyeSBzbyB0aGF0IGl0IG5vIGxvbmdlciBoYXMgJGluIG9uIHJlbGF0aW9uIGZpZWxkcywgb3JcbiAgLy8gZXF1YWwtdG8tcG9pbnRlciBjb25zdHJhaW50cyBvbiByZWxhdGlvbiBmaWVsZHMuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBxdWVyeSBpcyBtdXRhdGVkXG4gIHJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBhbnksIHNjaGVtYTogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBTZWFyY2ggZm9yIGFuIGluLXJlbGF0aW9uIG9yIGVxdWFsLXRvLXJlbGF0aW9uXG4gICAgLy8gTWFrZSBpdCBzZXF1ZW50aWFsIGZvciBub3csIG5vdCBzdXJlIG9mIHBhcmFsbGVpemF0aW9uIHNpZGUgZWZmZWN0c1xuICAgIGNvbnN0IHByb21pc2VzID0gW107XG4gICAgaWYgKHF1ZXJ5Wyckb3InXSkge1xuICAgICAgY29uc3Qgb3JzID0gcXVlcnlbJyRvciddO1xuICAgICAgcHJvbWlzZXMucHVzaChcbiAgICAgICAgLi4ub3JzLm1hcCgoYVF1ZXJ5LCBpbmRleCkgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lLCBhUXVlcnksIHNjaGVtYSkudGhlbihhUXVlcnkgPT4ge1xuICAgICAgICAgICAgcXVlcnlbJyRvciddW2luZGV4XSA9IGFRdWVyeTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChxdWVyeVsnJGFuZCddKSB7XG4gICAgICBjb25zdCBhbmRzID0gcXVlcnlbJyRhbmQnXTtcbiAgICAgIHByb21pc2VzLnB1c2goXG4gICAgICAgIC4uLmFuZHMubWFwKChhUXVlcnksIGluZGV4KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlSW5SZWxhdGlvbihjbGFzc05hbWUsIGFRdWVyeSwgc2NoZW1hKS50aGVuKGFRdWVyeSA9PiB7XG4gICAgICAgICAgICBxdWVyeVsnJGFuZCddW2luZGV4XSA9IGFRdWVyeTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3RoZXJLZXlzID0gT2JqZWN0LmtleXMocXVlcnkpLm1hcChrZXkgPT4ge1xuICAgICAgaWYgKGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRvcicpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdCA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgaWYgKCF0IHx8IHQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIGxldCBxdWVyaWVzOiA/KGFueVtdKSA9IG51bGw7XG4gICAgICBpZiAoXG4gICAgICAgIHF1ZXJ5W2tleV0gJiZcbiAgICAgICAgKHF1ZXJ5W2tleV1bJyRpbiddIHx8XG4gICAgICAgICAgcXVlcnlba2V5XVsnJG5lJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldWyckbmluJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldLl9fdHlwZSA9PSAnUG9pbnRlcicpXG4gICAgICApIHtcbiAgICAgICAgLy8gQnVpbGQgdGhlIGxpc3Qgb2YgcXVlcmllc1xuICAgICAgICBxdWVyaWVzID0gT2JqZWN0LmtleXMocXVlcnlba2V5XSkubWFwKGNvbnN0cmFpbnRLZXkgPT4ge1xuICAgICAgICAgIGxldCByZWxhdGVkSWRzO1xuICAgICAgICAgIGxldCBpc05lZ2F0aW9uID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGNvbnN0cmFpbnRLZXkgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBbcXVlcnlba2V5XS5vYmplY3RJZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckaW4nKSB7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJGluJ10ubWFwKHIgPT4gci5vYmplY3RJZCk7XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckbmluJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJG5pbiddLm1hcChyID0+IHIub2JqZWN0SWQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoY29uc3RyYWludEtleSA9PSAnJG5lJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gW3F1ZXJ5W2tleV1bJyRuZSddLm9iamVjdElkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaXNOZWdhdGlvbixcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyaWVzID0gW3sgaXNOZWdhdGlvbjogZmFsc2UsIHJlbGF0ZWRJZHM6IFtdIH1dO1xuICAgICAgfVxuXG4gICAgICAvLyByZW1vdmUgdGhlIGN1cnJlbnQgcXVlcnlLZXkgYXMgd2UgZG9uLHQgbmVlZCBpdCBhbnltb3JlXG4gICAgICBkZWxldGUgcXVlcnlba2V5XTtcbiAgICAgIC8vIGV4ZWN1dGUgZWFjaCBxdWVyeSBpbmRlcGVuZGVudGx5IHRvIGJ1aWxkIHRoZSBsaXN0IG9mXG4gICAgICAvLyAkaW4gLyAkbmluXG4gICAgICBjb25zdCBwcm9taXNlcyA9IHF1ZXJpZXMubWFwKHEgPT4ge1xuICAgICAgICBpZiAoIXEpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMub3duaW5nSWRzKGNsYXNzTmFtZSwga2V5LCBxLnJlbGF0ZWRJZHMpLnRoZW4oaWRzID0+IHtcbiAgICAgICAgICBpZiAocS5pc05lZ2F0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLmFkZE5vdEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKFsuLi5wcm9taXNlcywgLi4ub3RoZXJLZXlzXSkudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1vZGlmaWVzIHF1ZXJ5IHNvIHRoYXQgaXQgbm8gbG9uZ2VyIGhhcyAkcmVsYXRlZFRvXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBxdWVyeSBpcyBtdXRhdGVkXG4gIHJlZHVjZVJlbGF0aW9uS2V5cyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHF1ZXJ5T3B0aW9uczogYW55LFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdLFxuICAgIGlzTWFzdGVyOiBib29sZWFuID0gZmFsc2UsXG4gICAgc2NoZW1hQ29udHJvbGxlcjogP1NjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiA/UHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHF1ZXJ5Wyckb3InXSkge1xuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICBxdWVyeVsnJG9yJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChxdWVyeVsnJGFuZCddKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHF1ZXJ5WyckYW5kJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHF1ZXJ5Wyckbm9yJ10pKSB7XG4gICAgICAvLyBHdWFyZCB3aXRoIEFycmF5LmlzQXJyYXkgKHVubGlrZSB0aGUgbGVnYWN5ICRvci8kYW5kIGNoZWNrcyBhYm92ZSkgc28gYVxuICAgICAgLy8gbWFsZm9ybWVkIG5vbi1hcnJheSAkbm9yIHN0aWxsIGZhbGxzIHRocm91Z2ggdG8gdmFsaWRhdGVRdWVyeSBhbmQgeWllbGRzXG4gICAgICAvLyB0aGUgZXhpc3RpbmcgSU5WQUxJRF9RVUVSWSBlcnJvciBpbnN0ZWFkIG9mIHRocm93aW5nIGhlcmUuXG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHF1ZXJ5Wyckbm9yJ10ubWFwKGFRdWVyeSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgYVF1ZXJ5LFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuICAgIHZhciByZWxhdGVkVG8gPSBxdWVyeVsnJHJlbGF0ZWRUbyddO1xuICAgIGlmIChyZWxhdGVkVG8pIHtcbiAgICAgIC8vIFRoZSBvd25pbmcgcmVmZXJlbmNlIGFuZCByZWxhdGlvbiBrZXkgbXVzdCBiZSB3ZWxsLWZvcm1lZCBzdHJpbmdzLiBBXG4gICAgICAvLyBub24tc3RyaW5nIG9iamVjdElkIChlLmcuIGEgcXVlcnkgb3BlcmF0b3Igc3VjaCBhcyBgeyRndDogJyd9YCkgd291bGRcbiAgICAgIC8vIHBhc3MgYGF1dGhvcml6ZVJlbGF0ZWRUb1F1ZXJ5YCBleGlzdGVudGlhbGx5IGFnYWluc3QgYW55IHJlYWRhYmxlIG93bmVyXG4gICAgICAvLyB3aGlsZSBgcmVsYXRlZElkc2AgYXBwbGllcyB0aGUgb3BlcmF0b3IgYWNyb3NzIGV2ZXJ5IG93bmVyLCBkaXNjbG9zaW5nXG4gICAgICAvLyByZWxhdGlvbiBtZW1iZXJzaGlwIG9mIG93bmluZyBvYmplY3RzIHRoZSBjYWxsZXIgY2Fubm90IHJlYWQuXG4gICAgICBjb25zdCByZWxhdGVkVG9PYmplY3QgPSByZWxhdGVkVG8ub2JqZWN0O1xuICAgICAgaWYgKFxuICAgICAgICAhcmVsYXRlZFRvT2JqZWN0IHx8XG4gICAgICAgIHR5cGVvZiByZWxhdGVkVG9PYmplY3QuY2xhc3NOYW1lICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICB0eXBlb2YgcmVsYXRlZFRvT2JqZWN0Lm9iamVjdElkICE9PSAnc3RyaW5nJyB8fFxuICAgICAgICB0eXBlb2YgcmVsYXRlZFRvLmtleSAhPT0gJ3N0cmluZydcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ0ludmFsaWQgJHJlbGF0ZWRUbyBjb25zdHJhaW50LicpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMuYXV0aG9yaXplUmVsYXRlZFRvUXVlcnkocmVsYXRlZFRvLCBhdXRoLCBhY2xHcm91cCwgaXNNYXN0ZXIsIHNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICAgIC50aGVuKGNhblJlYWRPd25pbmdPYmplY3QgPT4ge1xuICAgICAgICAgIGRlbGV0ZSBxdWVyeVsnJHJlbGF0ZWRUbyddO1xuICAgICAgICAgIGlmICghY2FuUmVhZE93bmluZ09iamVjdCkge1xuICAgICAgICAgICAgLy8gVGhlIGNhbGxlciBpcyBub3QgYWxsb3dlZCB0byByZWFkIHRoZSBvd25pbmcgb2JqZWN0LCBzbyB0aGVcbiAgICAgICAgICAgIC8vIHJlbGF0aW9uIG11c3Qgbm90IGRpc2Nsb3NlIGFueSBsaW5rZWQgb2JqZWN0cyAoYW5kIG11c3Qgbm90IGFjdFxuICAgICAgICAgICAgLy8gYXMgYSBtZW1iZXJzaGlwIG9yYWNsZSBmb3IgYSBrbm93biByZWxhdGVkIGlkKS5cbiAgICAgICAgICAgIHRoaXMuYWRkSW5PYmplY3RJZHNJZHMoW10sIHF1ZXJ5KTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZVJlbGF0aW9uS2V5cyhcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aGlzLnJlbGF0ZWRJZHMoXG4gICAgICAgICAgICByZWxhdGVkVG8ub2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICAgIHJlbGF0ZWRUby5rZXksXG4gICAgICAgICAgICByZWxhdGVkVG8ub2JqZWN0Lm9iamVjdElkLFxuICAgICAgICAgICAgcXVlcnlPcHRpb25zXG4gICAgICAgICAgKS50aGVuKGlkcyA9PiB7XG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKFxuICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICBxdWVyeU9wdGlvbnMsXG4gICAgICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICBpc01hc3RlcixcbiAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlclxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4ge30pO1xuICAgIH1cbiAgfVxuXG4gIC8vIEF1dGhvcml6ZXMgYSBgJHJlbGF0ZWRUb2AgcmVsYXRpb24gcXVlcnkgYWdhaW5zdCB0aGUgb3duaW5nIG9iamVjdCBiZWZvcmVcbiAgLy8gaXRzIGpvaW4gdGFibGUgaXMgcmVhZCBieSBgcmVsYXRlZElkc2AuIFdpdGhvdXQgdGhpcyBjaGVjaywgYCRyZWxhdGVkVG9gXG4gIC8vIGJ5cGFzc2VzIGJvdGggYHByb3RlY3RlZEZpZWxkc2AgYW5kIHRoZSBvd25pbmcgb2JqZWN0J3MgQUNML0NMUCwgYmVjYXVzZVxuICAvLyB0aGUgZG93bnN0cmVhbSBwcm90ZWN0ZWQtZmllbGQgYW5kIEFDTCBmaWx0ZXJzIG9ubHkgYXBwbHkgdG8gdGhlIHF1ZXJpZWRcbiAgLy8gKHRhcmdldCkgY2xhc3MsIG5ldmVyIHRvIHRoZSBvd25pbmcgY2xhc3MgcmVmZXJlbmNlZCBieSBgJHJlbGF0ZWRUb2AuXG4gIC8vXG4gIC8vIC0gVGhyb3dzIGBPUEVSQVRJT05fRk9SQklEREVOYCBpZiB0aGUgcmVsYXRpb24ga2V5IGlzIGEgcHJvdGVjdGVkIGZpZWxkIG9uXG4gIC8vICAgdGhlIG93bmluZyBjbGFzcyBmb3IgdGhlIGNhbGxlcidzIGF1dGggY29udGV4dCAobWlycm9ycyB0aGUgcHJvdGVjdGVkXG4gIC8vICAgV0hFUkUtZmllbGQgZGVuaWFsIGluIGBSZXN0UXVlcnkuZGVueVByb3RlY3RlZEZpZWxkc2ApLlxuICAvLyAtIFJlc29sdmVzIHRvIGB0cnVlYCBpZiB0aGUgY2FsbGVyIG1heSByZWFkIHRoZSBvd25pbmcgb2JqZWN0IChzbyB0aGUgam9pblxuICAvLyAgIHRhYmxlIHJlYWQgbWF5IHByb2NlZWQpLCBvciBgZmFsc2VgIG90aGVyd2lzZSAoc28gdGhlIHJlbGF0aW9uIHlpZWxkcyBub1xuICAvLyAgIHJlc3VsdHMgYW5kIGNhbm5vdCBiZSB1c2VkIGFzIGEgbWVtYmVyc2hpcCBvcmFjbGUpLlxuICAvL1xuICAvLyBNYXN0ZXIgYW5kIG1haW50ZW5hbmNlIHJlcXVlc3RzIGJ5cGFzcyBib3RoIGNoZWNrcyBieSBkZXNpZ24uXG4gIGF1dGhvcml6ZVJlbGF0ZWRUb1F1ZXJ5KFxuICAgIHJlbGF0ZWRUbzogYW55LFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdLFxuICAgIGlzTWFzdGVyOiBib29sZWFuID0gZmFsc2UsXG4gICAgc2NoZW1hQ29udHJvbGxlcjogP1NjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBpZiAoaXNNYXN0ZXIpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICAgIGNvbnN0IG93bmluZ0NsYXNzTmFtZSA9IHJlbGF0ZWRUbyAmJiByZWxhdGVkVG8ub2JqZWN0ICYmIHJlbGF0ZWRUby5vYmplY3QuY2xhc3NOYW1lO1xuICAgIGNvbnN0IG93bmluZ0lkID0gcmVsYXRlZFRvICYmIHJlbGF0ZWRUby5vYmplY3QgJiYgcmVsYXRlZFRvLm9iamVjdC5vYmplY3RJZDtcbiAgICBjb25zdCByZWxhdGlvbktleSA9IHJlbGF0ZWRUbyAmJiByZWxhdGVkVG8ua2V5O1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZChzY2hlbWFDb250cm9sbGVyKS50aGVuKGxvYWRlZFNjaGVtYSA9PiB7XG4gICAgICAvLyAxLiBUaGUgcmVsYXRpb24ga2V5IG11c3Qgbm90IGJlIGEgcHJvdGVjdGVkIGZpZWxkIG9uIHRoZSBvd25pbmcgY2xhc3MuXG4gICAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPVxuICAgICAgICB0aGlzLmFkZFByb3RlY3RlZEZpZWxkcyhsb2FkZWRTY2hlbWEsIG93bmluZ0NsYXNzTmFtZSwge30sIGFjbEdyb3VwLCBhdXRoKSB8fCBbXTtcbiAgICAgIGNvbnN0IHJvb3RGaWVsZCA9IHR5cGVvZiByZWxhdGlvbktleSA9PT0gJ3N0cmluZycgPyByZWxhdGlvbktleS5zcGxpdCgnLicpWzBdIDogcmVsYXRpb25LZXk7XG4gICAgICBpZiAocHJvdGVjdGVkRmllbGRzLmluY2x1ZGVzKHJlbGF0aW9uS2V5KSB8fCBwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMocm9vdEZpZWxkKSkge1xuICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgIGBUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gcXVlcnkgJHtyZWxhdGlvbktleX0gb24gY2xhc3MgJHtvd25pbmdDbGFzc05hbWV9YCxcbiAgICAgICAgICB0aGlzLm9wdGlvbnNcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIDIuIFRoZSBjYWxsZXIgbXVzdCBiZSBhYmxlIHRvIHJlYWQgdGhlIG93bmluZyBvYmplY3QgaXRzZWxmLiBBIHJlYWQgd2l0aFxuICAgICAgLy8gICAgdGhlIGNhbGxlcidzIGF1dGggY29udGV4dCBhcHBsaWVzIHRoZSBvd25pbmcgY2xhc3MgQ0xQLCB0aGUgb2JqZWN0XG4gICAgICAvLyAgICBBQ0wgYW5kIHBvaW50ZXIgcGVybWlzc2lvbnMuIEFueSBcIm5vdCBhdXRob3JpemVkXCIgb3IgXCJub3QgZm91bmRcIlxuICAgICAgLy8gICAgb3V0Y29tZSBtYXBzIHRvIFwiY2Fubm90IHJlYWRcIiwgc28gdGhlIHJlbGF0aW9uIHJldHVybnMgbm8gcmVzdWx0cy5cbiAgICAgIHJldHVybiB0aGlzLmZpbmQoXG4gICAgICAgIG93bmluZ0NsYXNzTmFtZSxcbiAgICAgICAgeyBvYmplY3RJZDogb3duaW5nSWQgfSxcbiAgICAgICAgeyBhY2w6IGFjbEdyb3VwLCBsaW1pdDogMSwga2V5czogWydvYmplY3RJZCddLCBvcDogJ2dldCcgfSxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgbG9hZGVkU2NoZW1hXG4gICAgICApXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4gQXJyYXkuaXNBcnJheShyZXN1bHRzKSAmJiByZXN1bHRzLmxlbmd0aCA+IDApXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBQYXJzZS5FcnJvciAmJlxuICAgICAgICAgICAgKGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4gfHxcbiAgICAgICAgICAgICAgZXJyb3IuY29kZSA9PT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORClcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgYWRkSW5PYmplY3RJZHNJZHMoaWRzOiA/QXJyYXk8c3RyaW5nPiA9IG51bGwsIHF1ZXJ5OiBhbnkpIHtcbiAgICBjb25zdCBpZHNGcm9tU3RyaW5nOiA/QXJyYXk8c3RyaW5nPiA9XG4gICAgICB0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT09ICdzdHJpbmcnID8gW3F1ZXJ5Lm9iamVjdElkXSA6IG51bGw7XG4gICAgY29uc3QgaWRzRnJvbUVxOiA/QXJyYXk8c3RyaW5nPiA9XG4gICAgICBxdWVyeS5vYmplY3RJZCAmJiBxdWVyeS5vYmplY3RJZFsnJGVxJ10gPyBbcXVlcnkub2JqZWN0SWRbJyRlcSddXSA6IG51bGw7XG4gICAgY29uc3QgaWRzRnJvbUluOiA/QXJyYXk8c3RyaW5nPiA9XG4gICAgICBxdWVyeS5vYmplY3RJZCAmJiBxdWVyeS5vYmplY3RJZFsnJGluJ10gPyBxdWVyeS5vYmplY3RJZFsnJGluJ10gOiBudWxsO1xuXG4gICAgLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG4gICAgY29uc3QgYWxsSWRzOiBBcnJheTxBcnJheTxzdHJpbmc+PiA9IFtpZHNGcm9tU3RyaW5nLCBpZHNGcm9tRXEsIGlkc0Zyb21JbiwgaWRzXS5maWx0ZXIoXG4gICAgICBsaXN0ID0+IGxpc3QgIT09IG51bGxcbiAgICApO1xuICAgIGNvbnN0IHRvdGFsTGVuZ3RoID0gYWxsSWRzLnJlZHVjZSgobWVtbywgbGlzdCkgPT4gbWVtbyArIGxpc3QubGVuZ3RoLCAwKTtcblxuICAgIGxldCBpZHNJbnRlcnNlY3Rpb24gPSBbXTtcbiAgICBpZiAodG90YWxMZW5ndGggPiAxMjUpIHtcbiAgICAgIGlkc0ludGVyc2VjdGlvbiA9IGludGVyc2VjdC5iaWcoYWxsSWRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWRzSW50ZXJzZWN0aW9uID0gaW50ZXJzZWN0KGFsbElkcyk7XG4gICAgfVxuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJGluOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRpbjogdW5kZWZpbmVkLFxuICAgICAgICAkZXE6IHF1ZXJ5Lm9iamVjdElkLFxuICAgICAgfTtcbiAgICB9XG4gICAgcXVlcnkub2JqZWN0SWRbJyRpbiddID0gaWRzSW50ZXJzZWN0aW9uO1xuXG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgYWRkTm90SW5PYmplY3RJZHNJZHMoaWRzOiBzdHJpbmdbXSA9IFtdLCBxdWVyeTogYW55KSB7XG4gICAgY29uc3QgaWRzRnJvbU5pbiA9IHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckbmluJ10gPyBxdWVyeS5vYmplY3RJZFsnJG5pbiddIDogW107XG4gICAgbGV0IGFsbElkcyA9IFsuLi5pZHNGcm9tTmluLCAuLi5pZHNdLmZpbHRlcihsaXN0ID0+IGxpc3QgIT09IG51bGwpO1xuXG4gICAgLy8gbWFrZSBhIHNldCBhbmQgc3ByZWFkIHRvIHJlbW92ZSBkdXBsaWNhdGVzXG4gICAgYWxsSWRzID0gWy4uLm5ldyBTZXQoYWxsSWRzKV07XG5cbiAgICAvLyBOZWVkIHRvIG1ha2Ugc3VyZSB3ZSBkb24ndCBjbG9iYmVyIGV4aXN0aW5nIHNob3J0aGFuZCAkZXEgY29uc3RyYWludHMgb24gb2JqZWN0SWQuXG4gICAgaWYgKCEoJ29iamVjdElkJyBpbiBxdWVyeSkpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkbmluOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRuaW46IHVuZGVmaW5lZCxcbiAgICAgICAgJGVxOiBxdWVyeS5vYmplY3RJZCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcXVlcnkub2JqZWN0SWRbJyRuaW4nXSA9IGFsbElkcztcbiAgICByZXR1cm4gcXVlcnk7XG4gIH1cblxuICAvLyBSdW5zIGEgcXVlcnkgb24gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGEgbGlzdCBvZiBpdGVtcy5cbiAgLy8gT3B0aW9uczpcbiAgLy8gICBza2lwICAgIG51bWJlciBvZiByZXN1bHRzIHRvIHNraXAuXG4gIC8vICAgbGltaXQgICBsaW1pdCB0byB0aGlzIG51bWJlciBvZiByZXN1bHRzLlxuICAvLyAgIHNvcnQgICAgYW4gb2JqZWN0IHdoZXJlIGtleXMgYXJlIHRoZSBmaWVsZHMgdG8gc29ydCBieS5cbiAgLy8gICAgICAgICAgIHRoZSB2YWx1ZSBpcyArMSBmb3IgYXNjZW5kaW5nLCAtMSBmb3IgZGVzY2VuZGluZy5cbiAgLy8gICBjb3VudCAgIHJ1biBhIGNvdW50IGluc3RlYWQgb2YgcmV0dXJuaW5nIHJlc3VsdHMuXG4gIC8vICAgYWNsICAgICByZXN0cmljdCB0aGlzIG9wZXJhdGlvbiB3aXRoIGFuIEFDTCBmb3IgdGhlIHByb3ZpZGVkIGFycmF5XG4gIC8vICAgICAgICAgICBvZiB1c2VyIG9iamVjdElkcyBhbmQgcm9sZXMuIGFjbDogbnVsbCBtZWFucyBubyB1c2VyLlxuICAvLyAgICAgICAgICAgd2hlbiB0aGlzIGZpZWxkIGlzIG5vdCBwcmVzZW50LCBkb24ndCBkbyBhbnl0aGluZyByZWdhcmRpbmcgQUNMcy5cbiAgLy8gIGNhc2VJbnNlbnNpdGl2ZSBtYWtlIHN0cmluZyBjb21wYXJpc29ucyBjYXNlIGluc2Vuc2l0aXZlXG4gIC8vIFRPRE86IG1ha2UgdXNlcklkcyBub3QgbmVlZGVkIGhlcmUuIFRoZSBkYiBhZGFwdGVyIHNob3VsZG4ndCBrbm93XG4gIC8vIGFueXRoaW5nIGFib3V0IHVzZXJzLCBpZGVhbGx5LiBUaGVuLCBpbXByb3ZlIHRoZSBmb3JtYXQgb2YgdGhlIEFDTFxuICAvLyBhcmcgdG8gd29yayBsaWtlIHRoZSBvdGhlcnMuXG4gIGZpbmQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBhY2wsXG4gICAgICBzb3J0ID0ge30sXG4gICAgICBjb3VudCxcbiAgICAgIGtleXMsXG4gICAgICBvcCxcbiAgICAgIGRpc3RpbmN0LFxuICAgICAgcGlwZWxpbmUsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIGhpbnQsXG4gICAgICBjYXNlSW5zZW5zaXRpdmUgPSBmYWxzZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgICBjb21tZW50LFxuICAgICAgcmF3VmFsdWVzLFxuICAgICAgcmF3RmllbGROYW1lcyxcbiAgICB9OiBhbnkgPSB7fSxcbiAgICBhdXRoOiBhbnkgPSB7fSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGlzTWFpbnRlbmFuY2UgPSBhdXRoLmlzTWFpbnRlbmFuY2U7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZCB8fCBpc01haW50ZW5hbmNlO1xuICAgIGNvbnN0IGFjbEdyb3VwID0gYWNsIHx8IFtdO1xuICAgIG9wID1cbiAgICAgIG9wIHx8ICh0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT0gJ3N0cmluZycgJiYgT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PT0gMSA/ICdnZXQnIDogJ2ZpbmQnKTtcbiAgICAvLyBDb3VudCBvcGVyYXRpb24gaWYgY291bnRpbmdcbiAgICBvcCA9IGNvdW50ID09PSB0cnVlID8gJ2NvdW50JyA6IG9wO1xuXG4gICAgbGV0IGNsYXNzRXhpc3RzID0gdHJ1ZTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hSWZOZWVkZWQodmFsaWRTY2hlbWFDb250cm9sbGVyKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgLy9BbGxvdyB2b2xhdGlsZSBjbGFzc2VzIGlmIHF1ZXJ5aW5nIHdpdGggTWFzdGVyIChmb3IgX1B1c2hTdGF0dXMpXG4gICAgICAvL1RPRE86IE1vdmUgdm9sYXRpbGUgY2xhc3NlcyBjb25jZXB0IGludG8gbW9uZ28gYWRhcHRlciwgcG9zdGdyZXMgYWRhcHRlciBzaG91bGRuJ3QgY2FyZVxuICAgICAgLy90aGF0IGFwaS5wYXJzZS5jb20gYnJlYWtzIHdoZW4gX1B1c2hTdGF0dXMgZXhpc3RzIGluIG1vbmdvLlxuICAgICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIGlzTWFzdGVyKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIC8vIEJlaGF2aW9yIGZvciBub24tZXhpc3RlbnQgY2xhc3NlcyBpcyBraW5kYSB3ZWlyZCBvbiBQYXJzZS5jb20uIFByb2JhYmx5IGRvZXNuJ3QgbWF0dGVyIHRvbyBtdWNoLlxuICAgICAgICAgIC8vIEZvciBub3csIHByZXRlbmQgdGhlIGNsYXNzIGV4aXN0cyBidXQgaGFzIG5vIG9iamVjdHMsXG4gICAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNsYXNzRXhpc3RzID0gZmFsc2U7XG4gICAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICAgIC8vIFBhcnNlLmNvbSB0cmVhdHMgcXVlcmllcyBvbiBfY3JlYXRlZF9hdCBhbmQgX3VwZGF0ZWRfYXQgYXMgaWYgdGhleSB3ZXJlIHF1ZXJpZXMgb24gY3JlYXRlZEF0IGFuZCB1cGRhdGVkQXQsXG4gICAgICAgICAgLy8gc28gZHVwbGljYXRlIHRoYXQgYmVoYXZpb3IgaGVyZS4gSWYgYm90aCBhcmUgc3BlY2lmaWVkLCB0aGUgY29ycmVjdCBiZWhhdmlvciB0byBtYXRjaCBQYXJzZS5jb20gaXMgdG9cbiAgICAgICAgICAvLyB1c2UgdGhlIG9uZSB0aGF0IGFwcGVhcnMgZmlyc3QgaW4gdGhlIHNvcnQgbGlzdC5cbiAgICAgICAgICBpZiAoc29ydC5fY3JlYXRlZF9hdCkge1xuICAgICAgICAgICAgc29ydC5jcmVhdGVkQXQgPSBzb3J0Ll9jcmVhdGVkX2F0O1xuICAgICAgICAgICAgZGVsZXRlIHNvcnQuX2NyZWF0ZWRfYXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChzb3J0Ll91cGRhdGVkX2F0KSB7XG4gICAgICAgICAgICBzb3J0LnVwZGF0ZWRBdCA9IHNvcnQuX3VwZGF0ZWRfYXQ7XG4gICAgICAgICAgICBkZWxldGUgc29ydC5fdXBkYXRlZF9hdDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcXVlcnlPcHRpb25zID0ge1xuICAgICAgICAgICAgc2tpcCxcbiAgICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgICAgc29ydCxcbiAgICAgICAgICAgIGtleXMsXG4gICAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICBjYXNlSW5zZW5zaXRpdmU6IHRoaXMub3B0aW9ucy5lbmFibGVDb2xsYXRpb25DYXNlQ29tcGFyaXNvbiA/IGZhbHNlIDogY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICAgIGNvbW1lbnQsXG4gICAgICAgICAgfTtcbiAgICAgICAgICBPYmplY3Qua2V5cyhzb3J0KS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lLm1hdGNoKC9eYXV0aERhdGFcXC4oW2EtekEtWjAtOV9dKylcXC5pZCQvKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYENhbm5vdCBzb3J0IGJ5ICR7ZmllbGROYW1lfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkTmFtZSA9IGdldFJvb3RGaWVsZE5hbWUoZmllbGROYW1lKTtcbiAgICAgICAgICAgIGlmICghU2NoZW1hQ29udHJvbGxlci5maWVsZE5hbWVJc1ZhbGlkKHJvb3RGaWVsZE5hbWUsIGNsYXNzTmFtZSkpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgYEludmFsaWQgZmllbGQgbmFtZTogJHtmaWVsZE5hbWV9LmBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWUuc3BsaXQoJy4nKVswXV0gJiYgZmllbGROYW1lICE9PSAnc2NvcmUnKSB7XG4gICAgICAgICAgICAgIGRlbGV0ZSBzb3J0W2ZpZWxkTmFtZV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAgICAgOiBzY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihjbGFzc05hbWUsIGFjbEdyb3VwLCBvcClcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PlxuICAgICAgICAgICAgICB0aGlzLnJlZHVjZVJlbGF0aW9uS2V5cyhcbiAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgcXVlcnlPcHRpb25zLFxuICAgICAgICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlclxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PiB0aGlzLnJlZHVjZUluUmVsYXRpb24oY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hQ29udHJvbGxlcikpXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIGxldCBwcm90ZWN0ZWRGaWVsZHM7XG4gICAgICAgICAgICAgIGlmICghaXNNYXN0ZXIpIHtcbiAgICAgICAgICAgICAgICBxdWVyeSA9IHRoaXMuYWRkUG9pbnRlclBlcm1pc3Npb25zKFxuICAgICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICBhY2xHcm91cFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgLyogRG9uJ3QgdXNlIHByb2plY3Rpb25zIHRvIG9wdGltaXplIHRoZSBwcm90ZWN0ZWRGaWVsZHMgc2luY2UgdGhlIHByb3RlY3RlZEZpZWxkc1xuICAgICAgICAgICAgICAgICAgYmFzZWQgb24gcG9pbnRlci1wZXJtaXNzaW9ucyBhcmUgZGV0ZXJtaW5lZCBhZnRlciBxdWVyeWluZy4gVGhlIGZpbHRlcmluZyBjYW5cbiAgICAgICAgICAgICAgICAgIG92ZXJ3cml0ZSB0aGUgcHJvdGVjdGVkIGZpZWxkcy4gKi9cbiAgICAgICAgICAgICAgICBwcm90ZWN0ZWRGaWVsZHMgPSB0aGlzLmFkZFByb3RlY3RlZEZpZWxkcyhcbiAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICAgICAgYXV0aCxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5T3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKCFxdWVyeSkge1xuICAgICAgICAgICAgICAgIGlmIChvcCA9PT0gJ2dldCcpIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnT2JqZWN0IG5vdCBmb3VuZC4nKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9wID09PSAndXBkYXRlJyB8fCBvcCA9PT0gJ2RlbGV0ZScpIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5ID0gYWRkV3JpdGVBQ0wocXVlcnksIGFjbEdyb3VwKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcXVlcnkgPSBhZGRSZWFkQUNMKHF1ZXJ5LCBhY2xHcm91cCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnksIGlzTWFzdGVyLCBpc01haW50ZW5hbmNlLCBmYWxzZSwgdGhpcy5vcHRpb25zKTtcbiAgICAgICAgICAgICAgaWYgKGNvdW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIDA7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY291bnQoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgaGludCxcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAoZGlzdGluY3QpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNsYXNzRXhpc3RzKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGlzdGluY3QoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCBkaXN0aW5jdCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKHBpcGVsaW5lKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmFnZ3JlZ2F0ZShcbiAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgICAgICAgICAgIHBpcGVsaW5lLFxuICAgICAgICAgICAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICAgICAgICAgICAgaGludCxcbiAgICAgICAgICAgICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudCxcbiAgICAgICAgICAgICAgICAgICAgcmF3VmFsdWVzLFxuICAgICAgICAgICAgICAgICAgICByYXdGaWVsZE5hbWVzXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5maW5kKGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgcXVlcnlPcHRpb25zKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAgICAgICAgICAgICAuZmluZChjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHF1ZXJ5T3B0aW9ucylcbiAgICAgICAgICAgICAgICAgIC50aGVuKG9iamVjdHMgPT5cbiAgICAgICAgICAgICAgICAgICAgb2JqZWN0cy5tYXAob2JqZWN0ID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICBvYmplY3QgPSB1bnRyYW5zZm9ybU9iamVjdEFDTChvYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmaWx0ZXJTZW5zaXRpdmVEYXRhKFxuICAgICAgICAgICAgICAgICAgICAgICAgaXNNYXN0ZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICBpc01haW50ZW5hbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvdGVjdGVkRmllbGRzLFxuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5vcHRpb25zLnByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0XG4gICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZGV0YWlsZWRNZXNzYWdlID1cbiAgICAgICAgICAgICAgICAgICAgICB0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGVycm9yXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGVycm9yPy5tZXNzYWdlIHx8ICdBbiBpbnRlcm5hbCBzZXJ2ZXIgZXJyb3Igb2NjdXJyZWQnO1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBjcmVhdGVTYW5pdGl6ZWRFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICAgICAgICAgICAgICAgZGV0YWlsZWRNZXNzYWdlLFxuICAgICAgICAgICAgICAgICAgICAgIHRoaXMub3B0aW9ucyxcbiAgICAgICAgICAgICAgICAgICAgICAnQW4gaW50ZXJuYWwgc2VydmVyIGVycm9yIG9jY3VycmVkJ1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGRlbGV0ZVNjaGVtYShjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCBzY2hlbWFDb250cm9sbGVyO1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoeyBjbGVhckNhY2hlOiB0cnVlIH0pXG4gICAgICAudGhlbihzID0+IHtcbiAgICAgICAgc2NoZW1hQ29udHJvbGxlciA9IHM7XG4gICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLnRoZW4oKHNjaGVtYTogYW55KSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLmNvbGxlY3Rpb25FeGlzdHMoY2xhc3NOYW1lKVxuICAgICAgICAgIC50aGVuKCgpID0+IHRoaXMuYWRhcHRlci5jb3VudChjbGFzc05hbWUsIHsgZmllbGRzOiB7fSB9LCBudWxsLCAnJywgZmFsc2UpKVxuICAgICAgICAgIC50aGVuKGNvdW50ID0+IHtcbiAgICAgICAgICAgIGlmIChjb3VudCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIDI1NSxcbiAgICAgICAgICAgICAgICBgQ2xhc3MgJHtjbGFzc05hbWV9IGlzIG5vdCBlbXB0eSwgY29udGFpbnMgJHtjb3VudH0gb2JqZWN0cywgY2Fubm90IGRyb3Agc2NoZW1hLmBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGVsZXRlQ2xhc3MoY2xhc3NOYW1lKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHdhc1BhcnNlQ29sbGVjdGlvbiA9PiB7XG4gICAgICAgICAgICBpZiAod2FzUGFyc2VDb2xsZWN0aW9uKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlbGF0aW9uRmllbGROYW1lcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPT4gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdSZWxhdGlvbidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICAgICAgICAgIHJlbGF0aW9uRmllbGROYW1lcy5tYXAobmFtZSA9PlxuICAgICAgICAgICAgICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZUNsYXNzKGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBuYW1lKSlcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgICAgU2NoZW1hQ2FjaGUuZGVsKGNsYXNzTmFtZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXIucmVsb2FkRGF0YSgpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gVGhpcyBoZWxwcyB0byBjcmVhdGUgaW50ZXJtZWRpYXRlIG9iamVjdHMgZm9yIHNpbXBsZXIgY29tcGFyaXNvbiBvZlxuICAvLyBrZXkgdmFsdWUgcGFpcnMgdXNlZCBpbiBxdWVyeSBvYmplY3RzLiBFYWNoIGtleSB2YWx1ZSBwYWlyIHdpbGwgcmVwcmVzZW50ZWRcbiAgLy8gaW4gYSBzaW1pbGFyIHdheSB0byBqc29uXG4gIG9iamVjdFRvRW50cmllc1N0cmluZ3MocXVlcnk6IGFueSk6IEFycmF5PHN0cmluZz4ge1xuICAgIHJldHVybiBPYmplY3QuZW50cmllcyhxdWVyeSkubWFwKGEgPT4gYS5tYXAocyA9PiBKU09OLnN0cmluZ2lmeShzKSkuam9pbignOicpKTtcbiAgfVxuXG4gIC8vIE5haXZlIGxvZ2ljIHJlZHVjZXIgZm9yIE9SIG9wZXJhdGlvbnMgbWVhbnQgdG8gYmUgdXNlZCBvbmx5IGZvciBwb2ludGVyIHBlcm1pc3Npb25zLlxuICByZWR1Y2VPck9wZXJhdGlvbihxdWVyeTogeyAkb3I6IEFycmF5PGFueT4gfSk6IGFueSB7XG4gICAgaWYgKCFxdWVyeS4kb3IpIHtcbiAgICAgIHJldHVybiBxdWVyeTtcbiAgICB9XG4gICAgY29uc3QgcXVlcmllcyA9IHF1ZXJ5LiRvci5tYXAocSA9PiB0aGlzLm9iamVjdFRvRW50cmllc1N0cmluZ3MocSkpO1xuICAgIGxldCByZXBlYXQgPSBmYWxzZTtcbiAgICBkbyB7XG4gICAgICByZXBlYXQgPSBmYWxzZTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcXVlcmllcy5sZW5ndGggLSAxOyBpKyspIHtcbiAgICAgICAgZm9yIChsZXQgaiA9IGkgKyAxOyBqIDwgcXVlcmllcy5sZW5ndGg7IGorKykge1xuICAgICAgICAgIGNvbnN0IFtzaG9ydGVyLCBsb25nZXJdID0gcXVlcmllc1tpXS5sZW5ndGggPiBxdWVyaWVzW2pdLmxlbmd0aCA/IFtqLCBpXSA6IFtpLCBqXTtcbiAgICAgICAgICBjb25zdCBmb3VuZEVudHJpZXMgPSBxdWVyaWVzW3Nob3J0ZXJdLnJlZHVjZShcbiAgICAgICAgICAgIChhY2MsIGVudHJ5KSA9PiBhY2MgKyAocXVlcmllc1tsb25nZXJdLmluY2x1ZGVzKGVudHJ5KSA/IDEgOiAwKSxcbiAgICAgICAgICAgIDBcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IHNob3J0ZXJFbnRyaWVzID0gcXVlcmllc1tzaG9ydGVyXS5sZW5ndGg7XG4gICAgICAgICAgaWYgKGZvdW5kRW50cmllcyA9PT0gc2hvcnRlckVudHJpZXMpIHtcbiAgICAgICAgICAgIC8vIElmIHRoZSBzaG9ydGVyIHF1ZXJ5IGlzIGNvbXBsZXRlbHkgY29udGFpbmVkIGluIHRoZSBsb25nZXIgb25lLCB3ZSBjYW4gc3RyaWtlXG4gICAgICAgICAgICAvLyBvdXQgdGhlIGxvbmdlciBxdWVyeS5cbiAgICAgICAgICAgIHF1ZXJ5LiRvci5zcGxpY2UobG9uZ2VyLCAxKTtcbiAgICAgICAgICAgIHF1ZXJpZXMuc3BsaWNlKGxvbmdlciwgMSk7XG4gICAgICAgICAgICByZXBlYXQgPSB0cnVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSB3aGlsZSAocmVwZWF0KTtcbiAgICBpZiAocXVlcnkuJG9yLmxlbmd0aCA9PT0gMSkge1xuICAgICAgcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5xdWVyeS4kb3JbMF0gfTtcbiAgICAgIGRlbGV0ZSBxdWVyeS4kb3I7XG4gICAgfVxuICAgIHJldHVybiBxdWVyeTtcbiAgfVxuXG4gIC8vIE5haXZlIGxvZ2ljIHJlZHVjZXIgZm9yIEFORCBvcGVyYXRpb25zIG1lYW50IHRvIGJlIHVzZWQgb25seSBmb3IgcG9pbnRlciBwZXJtaXNzaW9ucy5cbiAgcmVkdWNlQW5kT3BlcmF0aW9uKHF1ZXJ5OiB7ICRhbmQ6IEFycmF5PGFueT4gfSk6IGFueSB7XG4gICAgaWYgKCFxdWVyeS4kYW5kKSB7XG4gICAgICByZXR1cm4gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHF1ZXJpZXMgPSBxdWVyeS4kYW5kLm1hcChxID0+IHRoaXMub2JqZWN0VG9FbnRyaWVzU3RyaW5ncyhxKSk7XG4gICAgbGV0IHJlcGVhdCA9IGZhbHNlO1xuICAgIGRvIHtcbiAgICAgIHJlcGVhdCA9IGZhbHNlO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBxdWVyaWVzLmxlbmd0aCAtIDE7IGkrKykge1xuICAgICAgICBmb3IgKGxldCBqID0gaSArIDE7IGogPCBxdWVyaWVzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgY29uc3QgW3Nob3J0ZXIsIGxvbmdlcl0gPSBxdWVyaWVzW2ldLmxlbmd0aCA+IHF1ZXJpZXNbal0ubGVuZ3RoID8gW2osIGldIDogW2ksIGpdO1xuICAgICAgICAgIGNvbnN0IGZvdW5kRW50cmllcyA9IHF1ZXJpZXNbc2hvcnRlcl0ucmVkdWNlKFxuICAgICAgICAgICAgKGFjYywgZW50cnkpID0+IGFjYyArIChxdWVyaWVzW2xvbmdlcl0uaW5jbHVkZXMoZW50cnkpID8gMSA6IDApLFxuICAgICAgICAgICAgMFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3Qgc2hvcnRlckVudHJpZXMgPSBxdWVyaWVzW3Nob3J0ZXJdLmxlbmd0aDtcbiAgICAgICAgICBpZiAoZm91bmRFbnRyaWVzID09PSBzaG9ydGVyRW50cmllcykge1xuICAgICAgICAgICAgLy8gSWYgdGhlIHNob3J0ZXIgcXVlcnkgaXMgY29tcGxldGVseSBjb250YWluZWQgaW4gdGhlIGxvbmdlciBvbmUsIHdlIGNhbiBzdHJpa2VcbiAgICAgICAgICAgIC8vIG91dCB0aGUgc2hvcnRlciBxdWVyeS5cbiAgICAgICAgICAgIHF1ZXJ5LiRhbmQuc3BsaWNlKHNob3J0ZXIsIDEpO1xuICAgICAgICAgICAgcXVlcmllcy5zcGxpY2Uoc2hvcnRlciwgMSk7XG4gICAgICAgICAgICByZXBlYXQgPSB0cnVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSB3aGlsZSAocmVwZWF0KTtcbiAgICBpZiAocXVlcnkuJGFuZC5sZW5ndGggPT09IDEpIHtcbiAgICAgIHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ucXVlcnkuJGFuZFswXSB9O1xuICAgICAgZGVsZXRlIHF1ZXJ5LiRhbmQ7XG4gICAgfVxuICAgIHJldHVybiBxdWVyeTtcbiAgfVxuXG4gIC8vIENvbnN0cmFpbnRzIHF1ZXJ5IHVzaW5nIENMUCdzIHBvaW50ZXIgcGVybWlzc2lvbnMgKFBQKSBpZiBhbnkuXG4gIC8vIDEuIEV0cmFjdCB0aGUgdXNlciBpZCBmcm9tIGNhbGxlcidzIEFDTGdyb3VwO1xuICAvLyAyLiBFeGN0cmFjdCBhIGxpc3Qgb2YgZmllbGQgbmFtZXMgdGhhdCBhcmUgUFAgZm9yIHRhcmdldCBjb2xsZWN0aW9uIGFuZCBvcGVyYXRpb247XG4gIC8vIDMuIENvbnN0cmFpbnQgdGhlIG9yaWdpbmFsIHF1ZXJ5IHNvIHRoYXQgZWFjaCBQUCBmaWVsZCBtdXN0XG4gIC8vIHBvaW50IHRvIGNhbGxlcidzIGlkIChvciBjb250YWluIGl0IGluIGNhc2Ugb2YgUFAgZmllbGQgYmVpbmcgYW4gYXJyYXkpXG4gIGFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICBzY2hlbWE6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlcixcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvcGVyYXRpb246IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdXG4gICk6IGFueSB7XG4gICAgLy8gQ2hlY2sgaWYgY2xhc3MgaGFzIHB1YmxpYyBwZXJtaXNzaW9uIGZvciBvcGVyYXRpb25cbiAgICAvLyBJZiB0aGUgQmFzZUNMUCBwYXNzLCBsZXQgZ28gdGhyb3VnaFxuICAgIGlmIChzY2hlbWEudGVzdFBlcm1pc3Npb25zRm9yQ2xhc3NOYW1lKGNsYXNzTmFtZSwgYWNsR3JvdXAsIG9wZXJhdGlvbikpIHtcbiAgICAgIHJldHVybiBxdWVyeTtcbiAgICB9XG4gICAgY29uc3QgcGVybXMgPSBzY2hlbWEuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSk7XG5cbiAgICBjb25zdCB1c2VyQUNMID0gYWNsR3JvdXAuZmlsdGVyKGFjbCA9PiB7XG4gICAgICByZXR1cm4gYWNsLmluZGV4T2YoJ3JvbGU6JykgIT0gMCAmJiBhY2wgIT0gJyonO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZ3JvdXBLZXkgPVxuICAgICAgWydnZXQnLCAnZmluZCcsICdjb3VudCddLmluZGV4T2Yob3BlcmF0aW9uKSA+IC0xID8gJ3JlYWRVc2VyRmllbGRzJyA6ICd3cml0ZVVzZXJGaWVsZHMnO1xuXG4gICAgY29uc3QgcGVybUZpZWxkcyA9IFtdO1xuXG4gICAgaWYgKHBlcm1zW29wZXJhdGlvbl0gJiYgcGVybXNbb3BlcmF0aW9uXS5wb2ludGVyRmllbGRzKSB7XG4gICAgICBwZXJtRmllbGRzLnB1c2goLi4ucGVybXNbb3BlcmF0aW9uXS5wb2ludGVyRmllbGRzKTtcbiAgICB9XG5cbiAgICBpZiAocGVybXNbZ3JvdXBLZXldKSB7XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIHBlcm1zW2dyb3VwS2V5XSkge1xuICAgICAgICBpZiAoIXBlcm1GaWVsZHMuaW5jbHVkZXMoZmllbGQpKSB7XG4gICAgICAgICAgcGVybUZpZWxkcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyB0aGUgQUNMIHNob3VsZCBoYXZlIGV4YWN0bHkgMSB1c2VyXG4gICAgaWYgKHBlcm1GaWVsZHMubGVuZ3RoID4gMCkge1xuICAgICAgLy8gdGhlIEFDTCBzaG91bGQgaGF2ZSBleGFjdGx5IDEgdXNlclxuICAgICAgLy8gTm8gdXNlciBzZXQgcmV0dXJuIHVuZGVmaW5lZFxuICAgICAgLy8gSWYgdGhlIGxlbmd0aCBpcyA+IDEsIHRoYXQgbWVhbnMgd2UgZGlkbid0IGRlLWR1cGUgdXNlcnMgY29ycmVjdGx5XG4gICAgICBpZiAodXNlckFDTC5sZW5ndGggIT0gMSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB1c2VySWQgPSB1c2VyQUNMWzBdO1xuICAgICAgY29uc3QgdXNlclBvaW50ZXIgPSB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB1c2VySWQsXG4gICAgICB9O1xuXG4gICAgICBjb25zdCBxdWVyaWVzID0gcGVybUZpZWxkcy5tYXAoa2V5ID0+IHtcbiAgICAgICAgY29uc3QgZmllbGREZXNjcmlwdG9yID0gc2NoZW1hLmdldEV4cGVjdGVkVHlwZShjbGFzc05hbWUsIGtleSk7XG4gICAgICAgIGNvbnN0IGZpZWxkVHlwZSA9XG4gICAgICAgICAgZmllbGREZXNjcmlwdG9yICYmXG4gICAgICAgICAgdHlwZW9mIGZpZWxkRGVzY3JpcHRvciA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZmllbGREZXNjcmlwdG9yLCAndHlwZScpXG4gICAgICAgICAgICA/IGZpZWxkRGVzY3JpcHRvci50eXBlXG4gICAgICAgICAgICA6IG51bGw7XG5cbiAgICAgICAgbGV0IHF1ZXJ5Q2xhdXNlO1xuXG4gICAgICAgIGlmIChmaWVsZFR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICAgIC8vIGNvbnN0cmFpbnQgZm9yIHNpbmdsZSBwb2ludGVyIHNldHVwXG4gICAgICAgICAgcXVlcnlDbGF1c2UgPSB7IFtrZXldOiB1c2VyUG9pbnRlciB9O1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkVHlwZSA9PT0gJ0FycmF5Jykge1xuICAgICAgICAgIC8vIGNvbnN0cmFpbnQgZm9yIHVzZXJzLWFycmF5IHNldHVwXG4gICAgICAgICAgcXVlcnlDbGF1c2UgPSB7IFtrZXldOiB7ICRhbGw6IFt1c2VyUG9pbnRlcl0gfSB9O1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkVHlwZSA9PT0gJ09iamVjdCcpIHtcbiAgICAgICAgICAvLyBjb25zdHJhaW50IGZvciBvYmplY3Qgc2V0dXBcbiAgICAgICAgICBxdWVyeUNsYXVzZSA9IHsgW2tleV06IHVzZXJQb2ludGVyIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhpcyBtZWFucyB0aGF0IHRoZXJlIGlzIGEgQ0xQIGZpZWxkIG9mIGFuIHVuZXhwZWN0ZWQgdHlwZS4gVGhpcyBjb25kaXRpb24gc2hvdWxkIG5vdCBoYXBwZW4sIHdoaWNoIGlzXG4gICAgICAgICAgLy8gd2h5IGlzIGJlaW5nIHRyZWF0ZWQgYXMgYW4gZXJyb3IuXG4gICAgICAgICAgdGhyb3cgRXJyb3IoXG4gICAgICAgICAgICBgQW4gdW5leHBlY3RlZCBjb25kaXRpb24gb2NjdXJyZWQgd2hlbiByZXNvbHZpbmcgcG9pbnRlciBwZXJtaXNzaW9uczogJHtjbGFzc05hbWV9ICR7a2V5fWBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIGlmIHdlIGFscmVhZHkgaGF2ZSBhIGNvbnN0cmFpbnQgb24gdGhlIGtleSwgdXNlIHRoZSAkYW5kXG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocXVlcnksIGtleSkpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5yZWR1Y2VBbmRPcGVyYXRpb24oeyAkYW5kOiBbcXVlcnlDbGF1c2UsIHF1ZXJ5XSB9KTtcbiAgICAgICAgfVxuICAgICAgICAvLyBvdGhlcndpc2UganVzdCBhZGQgdGhlIGNvbnN0YWludFxuICAgICAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgcXVlcnksIHF1ZXJ5Q2xhdXNlKTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gcXVlcmllcy5sZW5ndGggPT09IDEgPyBxdWVyaWVzWzBdIDogdGhpcy5yZWR1Y2VPck9wZXJhdGlvbih7ICRvcjogcXVlcmllcyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHF1ZXJ5O1xuICAgIH1cbiAgfVxuXG4gIGFkZFByb3RlY3RlZEZpZWxkcyhcbiAgICBzY2hlbWE6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlciB8IGFueSxcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55ID0ge30sXG4gICAgYWNsR3JvdXA6IGFueVtdID0gW10sXG4gICAgYXV0aDogYW55ID0ge30sXG4gICAgcXVlcnlPcHRpb25zOiBGdWxsUXVlcnlPcHRpb25zID0ge31cbiAgKTogbnVsbCB8IHN0cmluZ1tdIHtcbiAgICBjb25zdCBwZXJtcyA9XG4gICAgICBzY2hlbWEgJiYgc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9uc1xuICAgICAgICA/IHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKVxuICAgICAgICA6IHNjaGVtYTtcbiAgICBpZiAoIXBlcm1zKSB7IHJldHVybiBudWxsOyB9XG5cbiAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPSBwZXJtcy5wcm90ZWN0ZWRGaWVsZHM7XG4gICAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMpIHsgcmV0dXJuIG51bGw7IH1cblxuICAgIGlmIChjbGFzc05hbWUgPT09ICdfVXNlcicgJiYgdGhpcy5vcHRpb25zLnByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0ICE9PSBmYWxzZSAmJiBhY2xHcm91cC5pbmRleE9mKHF1ZXJ5Lm9iamVjdElkKSA+IC0xKSB7IHJldHVybiBudWxsOyB9XG5cbiAgICAvLyBmb3IgcXVlcmllcyB3aGVyZSBcImtleXNcIiBhcmUgc2V0IGFuZCBkbyBub3QgaW5jbHVkZSBhbGwgJ3VzZXJGaWVsZCc6e2ZpZWxkfSxcbiAgICAvLyB3ZSBoYXZlIHRvIHRyYW5zcGFyZW50bHkgaW5jbHVkZSBpdCwgYW5kIHRoZW4gcmVtb3ZlIGJlZm9yZSByZXR1cm5pbmcgdG8gY2xpZW50XG4gICAgLy8gQmVjYXVzZSBpZiBzdWNoIGtleSBub3QgcHJvamVjdGVkIHRoZSBwZXJtaXNzaW9uIHdvbid0IGJlIGVuZm9yY2VkIHByb3Blcmx5XG4gICAgLy8gUFMgdGhpcyBpcyBjYWxsZWQgd2hlbiAnZXhjbHVkZUtleXMnIGFscmVhZHkgcmVkdWNlZCB0byAna2V5cydcbiAgICBjb25zdCBwcmVzZXJ2ZUtleXMgPSBxdWVyeU9wdGlvbnMua2V5cztcblxuICAgIC8vIHRoZXNlIGFyZSBrZXlzIHRoYXQgbmVlZCB0byBiZSBpbmNsdWRlZCBvbmx5XG4gICAgLy8gdG8gYmUgYWJsZSB0byBhcHBseSBwcm90ZWN0ZWRGaWVsZHMgYnkgcG9pbnRlclxuICAgIC8vIGFuZCB0aGVuIHVuc2V0IGJlZm9yZSByZXR1cm5pbmcgdG8gY2xpZW50IChsYXRlciBpbiAgZmlsdGVyU2Vuc2l0aXZlRmllbGRzKVxuICAgIGNvbnN0IHNlcnZlck9ubHlLZXlzID0gW107XG5cbiAgICBjb25zdCBhdXRoZW50aWNhdGVkID0gYXV0aC51c2VyO1xuXG4gICAgLy8gbWFwIHRvIGFsbG93IGNoZWNrIHdpdGhvdXQgYXJyYXkgc2VhcmNoXG4gICAgY29uc3Qgcm9sZXMgPSAoYXV0aC51c2VyUm9sZXMgfHwgW10pLnJlZHVjZSgoYWNjLCByKSA9PiB7XG4gICAgICBhY2Nbcl0gPSBwcm90ZWN0ZWRGaWVsZHNbcl07XG4gICAgICByZXR1cm4gYWNjO1xuICAgIH0sIHt9KTtcblxuICAgIC8vIGFycmF5IG9mIHNldHMgb2YgcHJvdGVjdGVkIGZpZWxkcy4gc2VwYXJhdGUgaXRlbSBmb3IgZWFjaCBhcHBsaWNhYmxlIGNyaXRlcmlhXG4gICAgY29uc3QgcHJvdGVjdGVkS2V5c1NldHMgPSBbXTtcblxuICAgIGZvciAoY29uc3Qga2V5IGluIHByb3RlY3RlZEZpZWxkcykge1xuICAgICAgLy8gc2tpcCB1c2VyRmllbGRzXG4gICAgICBpZiAoa2V5LnN0YXJ0c1dpdGgoJ3VzZXJGaWVsZDonKSkge1xuICAgICAgICBpZiAocHJlc2VydmVLZXlzKSB7XG4gICAgICAgICAgY29uc3QgZmllbGROYW1lID0ga2V5LnN1YnN0cmluZygxMCk7XG4gICAgICAgICAgaWYgKCFwcmVzZXJ2ZUtleXMuaW5jbHVkZXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgLy8gMS4gcHV0IGl0IHRoZXJlIHRlbXBvcmFyaWx5XG4gICAgICAgICAgICBxdWVyeU9wdGlvbnMua2V5cyAmJiBxdWVyeU9wdGlvbnMua2V5cy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAvLyAyLiBwcmVzZXJ2ZSBpdCBkZWxldGUgbGF0ZXJcbiAgICAgICAgICAgIHNlcnZlck9ubHlLZXlzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIGFkZCBwdWJsaWMgdGllclxuICAgICAgaWYgKGtleSA9PT0gJyonKSB7XG4gICAgICAgIHByb3RlY3RlZEtleXNTZXRzLnB1c2gocHJvdGVjdGVkRmllbGRzW2tleV0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKGF1dGhlbnRpY2F0ZWQpIHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ2F1dGhlbnRpY2F0ZWQnKSB7XG4gICAgICAgICAgLy8gZm9yIGxvZ2dlZCBpbiB1c2Vyc1xuICAgICAgICAgIHByb3RlY3RlZEtleXNTZXRzLnB1c2gocHJvdGVjdGVkRmllbGRzW2tleV0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHJvbGVzW2tleV0gJiYga2V5LnN0YXJ0c1dpdGgoJ3JvbGU6JykpIHtcbiAgICAgICAgICAvLyBhZGQgYXBwbGljYWJsZSByb2xlc1xuICAgICAgICAgIHByb3RlY3RlZEtleXNTZXRzLnB1c2gocm9sZXNba2V5XSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBjaGVjayBpZiB0aGVyZSdzIGEgcnVsZSBmb3IgY3VycmVudCB1c2VyJ3MgaWRcbiAgICBpZiAoYXV0aGVudGljYXRlZCkge1xuICAgICAgY29uc3QgdXNlcklkID0gYXV0aC51c2VyLmlkO1xuICAgICAgaWYgKHBlcm1zLnByb3RlY3RlZEZpZWxkc1t1c2VySWRdKSB7XG4gICAgICAgIHByb3RlY3RlZEtleXNTZXRzLnB1c2gocGVybXMucHJvdGVjdGVkRmllbGRzW3VzZXJJZF0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIHByZXNlcnZlIGZpZWxkcyB0byBiZSByZW1vdmVkIGJlZm9yZSBzZW5kaW5nIHJlc3BvbnNlIHRvIGNsaWVudFxuICAgIGlmIChzZXJ2ZXJPbmx5S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICBwZXJtcy5wcm90ZWN0ZWRGaWVsZHMudGVtcG9yYXJ5S2V5cyA9IHNlcnZlck9ubHlLZXlzO1xuICAgIH1cblxuICAgIGxldCBwcm90ZWN0ZWRLZXlzID0gcHJvdGVjdGVkS2V5c1NldHMucmVkdWNlKChhY2MsIG5leHQpID0+IHtcbiAgICAgIGlmIChuZXh0KSB7XG4gICAgICAgIGFjYy5wdXNoKC4uLm5leHQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGFjYztcbiAgICB9LCBbXSk7XG5cbiAgICAvLyBpbnRlcnNlY3QgYWxsIHNldHMgb2YgcHJvdGVjdGVkRmllbGRzXG4gICAgcHJvdGVjdGVkS2V5c1NldHMuZm9yRWFjaChmaWVsZHMgPT4ge1xuICAgICAgaWYgKGZpZWxkcykge1xuICAgICAgICBwcm90ZWN0ZWRLZXlzID0gcHJvdGVjdGVkS2V5cy5maWx0ZXIodiA9PiBmaWVsZHMuaW5jbHVkZXModikpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHByb3RlY3RlZEtleXM7XG4gIH1cblxuICBjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbigpIHtcbiAgICBpZiAodGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gfHwgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25QZW5kaW5nKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKCdUaGVyZSBpcyBhbHJlYWR5IGFuIGFjdGl2ZSB0cmFuc2FjdGlvbmFsIHNlc3Npb24nKSk7XG4gICAgfVxuICAgIC8vIFJlc2VydmUgdGhlIHNlc3Npb24gYmVmb3JlIGl0IGlzIGNyZWF0ZWQsIHdpdGhvdXQgc2V0dGluZyBgX3RyYW5zYWN0aW9uYWxTZXNzaW9uYCwgd2hpY2hcbiAgICAvLyBjb25jdXJyZW50IHdyaXRlcyBvbiB0aGlzIGNvbnRyb2xsZXIgd291bGQgb3RoZXJ3aXNlIHVzZVxuICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uUGVuZGluZyA9IHRydWU7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmFkYXB0ZXIuY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24oKSlcbiAgICAgIC50aGVuKHRyYW5zYWN0aW9uYWxTZXNzaW9uID0+IHtcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSB0cmFuc2FjdGlvbmFsU2Vzc2lvbjtcbiAgICAgIH0pXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uUGVuZGluZyA9IGZhbHNlO1xuICAgICAgfSk7XG4gIH1cblxuICBjb21taXRUcmFuc2FjdGlvbmFsU2Vzc2lvbigpIHtcbiAgICBpZiAoIXRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZXJlIGlzIG5vIHRyYW5zYWN0aW9uYWwgc2Vzc2lvbiB0byBjb21taXQnKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jb21taXRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbikudGhlbigoKSA9PiB7XG4gICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbiA9IG51bGw7XG4gICAgfSk7XG4gIH1cblxuICBhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKCkge1xuICAgIGlmICghdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVGhlcmUgaXMgbm8gdHJhbnNhY3Rpb25hbCBzZXNzaW9uIHRvIGFib3J0Jyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuYWJvcnRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbikudGhlbigoKSA9PiB7XG4gICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbiA9IG51bGw7XG4gICAgfSk7XG4gIH1cblxuICAvLyBUT0RPOiBjcmVhdGUgaW5kZXhlcyBvbiBmaXJzdCBjcmVhdGlvbiBvZiBhIF9Vc2VyIG9iamVjdC4gT3RoZXJ3aXNlIGl0J3MgaW1wb3NzaWJsZSB0b1xuICAvLyBoYXZlIGEgUGFyc2UgYXBwIHdpdGhvdXQgaXQgaGF2aW5nIGEgX1VzZXIgY29sbGVjdGlvbi5cbiAgYXN5bmMgcGVyZm9ybUluaXRpYWxpemF0aW9uKCkge1xuICAgIGF3YWl0IHRoaXMuYWRhcHRlci5wZXJmb3JtSW5pdGlhbGl6YXRpb24oe1xuICAgICAgVm9sYXRpbGVDbGFzc2VzU2NoZW1hczogU2NoZW1hQ29udHJvbGxlci5Wb2xhdGlsZUNsYXNzZXNTY2hlbWFzLFxuICAgIH0pO1xuICAgIGNvbnN0IHJlcXVpcmVkVXNlckZpZWxkcyA9IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9Vc2VyLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlcXVpcmVkUm9sZUZpZWxkcyA9IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgICAuLi5TY2hlbWFDb250cm9sbGVyLmRlZmF1bHRDb2x1bW5zLl9Sb2xlLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHJlcXVpcmVkSWRlbXBvdGVuY3lGaWVsZHMgPSB7XG4gICAgICBmaWVsZHM6IHtcbiAgICAgICAgLi4uU2NoZW1hQ29udHJvbGxlci5kZWZhdWx0Q29sdW1ucy5fRGVmYXVsdCxcbiAgICAgICAgLi4uU2NoZW1hQ29udHJvbGxlci5kZWZhdWx0Q29sdW1ucy5fSWRlbXBvdGVuY3ksXG4gICAgICB9LFxuICAgIH07XG4gICAgYXdhaXQgdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT4gc2NoZW1hLmVuZm9yY2VDbGFzc0V4aXN0cygnX1VzZXInKSk7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT4gc2NoZW1hLmVuZm9yY2VDbGFzc0V4aXN0cygnX1JvbGUnKSk7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT4gc2NoZW1hLmVuZm9yY2VDbGFzc0V4aXN0cygnX0lkZW1wb3RlbmN5JykpO1xuXG4gICAgY29uc3QgZGF0YWJhc2VPcHRpb25zID0gdGhpcy5vcHRpb25zLmRhdGFiYXNlT3B0aW9ucyB8fCB7fTtcblxuICAgIGlmIChkYXRhYmFzZU9wdGlvbnMuY3JlYXRlSW5kZXhVc2VyVXNlcm5hbWUgIT09IGZhbHNlKSB7XG4gICAgICBhd2FpdCB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1VzZXInLCByZXF1aXJlZFVzZXJGaWVsZHMsIFsndXNlcm5hbWUnXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciB1c2VybmFtZXM6ICcsIGVycm9yKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMub3B0aW9ucy5lbmFibGVDb2xsYXRpb25DYXNlQ29tcGFyaXNvbikge1xuICAgICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFVzZXJVc2VybmFtZUNhc2VJbnNlbnNpdGl2ZSAhPT0gZmFsc2UpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyXG4gICAgICAgICAgLmVuc3VyZUluZGV4KCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWyd1c2VybmFtZSddLCAnY2FzZV9pbnNlbnNpdGl2ZV91c2VybmFtZScsIHRydWUpXG4gICAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gY3JlYXRlIGNhc2UgaW5zZW5zaXRpdmUgdXNlcm5hbWUgaW5kZXg6ICcsIGVycm9yKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4VXNlckVtYWlsQ2FzZUluc2Vuc2l0aXZlICE9PSBmYWxzZSkge1xuICAgICAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgICAgICAuZW5zdXJlSW5kZXgoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ2VtYWlsJ10sICdjYXNlX2luc2Vuc2l0aXZlX2VtYWlsJywgdHJ1ZSlcbiAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBjcmVhdGUgY2FzZSBpbnNlbnNpdGl2ZSBlbWFpbCBpbmRleDogJywgZXJyb3IpO1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFVzZXJFbWFpbCAhPT0gZmFsc2UpIHtcbiAgICAgIGF3YWl0IHRoaXMuYWRhcHRlci5lbnN1cmVVbmlxdWVuZXNzKCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWydlbWFpbCddKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHVzZXIgZW1haWwgYWRkcmVzc2VzOiAnLCBlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFVzZXJFbWFpbFZlcmlmeVRva2VuICE9PSBmYWxzZSkge1xuICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyXG4gICAgICAgIC5lbnN1cmVJbmRleCgnX1VzZXInLCByZXF1aXJlZFVzZXJGaWVsZHMsIFsnX2VtYWlsX3ZlcmlmeV90b2tlbiddLCAnX2VtYWlsX3ZlcmlmeV90b2tlbicsIGZhbHNlKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gY3JlYXRlIGluZGV4IGZvciBlbWFpbCB2ZXJpZmljYXRpb24gdG9rZW46ICcsIGVycm9yKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFVzZXJQYXNzd29yZFJlc2V0VG9rZW4gIT09IGZhbHNlKSB7XG4gICAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgICAgLmVuc3VyZUluZGV4KCdfVXNlcicsIHJlcXVpcmVkVXNlckZpZWxkcywgWydfcGVyaXNoYWJsZV90b2tlbiddLCAnX3BlcmlzaGFibGVfdG9rZW4nLCBmYWxzZSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGNyZWF0ZSBpbmRleCBmb3IgcGFzc3dvcmQgcmVzZXQgdG9rZW46ICcsIGVycm9yKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKGRhdGFiYXNlT3B0aW9ucy5jcmVhdGVJbmRleFJvbGVOYW1lICE9PSBmYWxzZSkge1xuICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Sb2xlJywgcmVxdWlyZWRSb2xlRmllbGRzLCBbJ25hbWUnXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciByb2xlIG5hbWU6ICcsIGVycm9yKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmFkYXB0ZXJcbiAgICAgIC5lbnN1cmVVbmlxdWVuZXNzKCdfSWRlbXBvdGVuY3knLCByZXF1aXJlZElkZW1wb3RlbmN5RmllbGRzLCBbJ3JlcUlkJ10pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybignVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciBpZGVtcG90ZW5jeSByZXF1ZXN0IElEOiAnLCBlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBpc01vbmdvQWRhcHRlciA9IHRoaXMuYWRhcHRlciBpbnN0YW5jZW9mIE1vbmdvU3RvcmFnZUFkYXB0ZXI7XG4gICAgY29uc3QgaXNQb3N0Z3Jlc0FkYXB0ZXIgPSB0aGlzLmFkYXB0ZXIgaW5zdGFuY2VvZiBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyO1xuICAgIGlmIChpc01vbmdvQWRhcHRlciB8fCBpc1Bvc3RncmVzQWRhcHRlcikge1xuICAgICAgbGV0IG9wdGlvbnMgPSB7fTtcbiAgICAgIGlmIChpc01vbmdvQWRhcHRlcikge1xuICAgICAgICBvcHRpb25zID0ge1xuICAgICAgICAgIHR0bDogMCxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSBpZiAoaXNQb3N0Z3Jlc0FkYXB0ZXIpIHtcbiAgICAgICAgb3B0aW9ucyA9IHRoaXMuaWRlbXBvdGVuY3lPcHRpb25zO1xuICAgICAgICBvcHRpb25zLnNldElkZW1wb3RlbmN5RnVuY3Rpb24gPSB0cnVlO1xuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyXG4gICAgICAgIC5lbnN1cmVJbmRleCgnX0lkZW1wb3RlbmN5JywgcmVxdWlyZWRJZGVtcG90ZW5jeUZpZWxkcywgWydleHBpcmUnXSwgJ3R0bCcsIGZhbHNlLCBvcHRpb25zKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gY3JlYXRlIFRUTCBpbmRleCBmb3IgaWRlbXBvdGVuY3kgZXhwaXJlIGRhdGU6ICcsIGVycm9yKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIC8vIENyZWF0ZSB1bmlxdWUgaW5kZXhlcyBmb3IgYXV0aERhdGEgcHJvdmlkZXJzIHRvIHByZXZlbnQgcmFjZSBjb25kaXRpb25zXG4gICAgLy8gZHVyaW5nIGNvbmN1cnJlbnQgc2lnbnVwcyB3aXRoIHRoZSBzYW1lIGF1dGhEYXRhXG4gICAgaWYgKFxuICAgICAgZGF0YWJhc2VPcHRpb25zLmNyZWF0ZUluZGV4QXV0aERhdGFVbmlxdWVuZXNzICE9PSBmYWxzZSAmJlxuICAgICAgdHlwZW9mIHRoaXMuYWRhcHRlci5lbnN1cmVBdXRoRGF0YVVuaXF1ZW5lc3MgPT09ICdmdW5jdGlvbidcbiAgICApIHtcbiAgICAgIGNvbnN0IGF1dGhQcm92aWRlcnMgPSBPYmplY3Qua2V5cyh0aGlzLm9wdGlvbnMuYXV0aCB8fCB7fSk7XG4gICAgICBpZiAodGhpcy5vcHRpb25zLmVuYWJsZUFub255bW91c1VzZXJzICE9PSBmYWxzZSkge1xuICAgICAgICBpZiAoIWF1dGhQcm92aWRlcnMuaW5jbHVkZXMoJ2Fub255bW91cycpKSB7XG4gICAgICAgICAgYXV0aFByb3ZpZGVycy5wdXNoKCdhbm9ueW1vdXMnKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIGF1dGhQcm92aWRlcnMubWFwKHByb3ZpZGVyID0+XG4gICAgICAgICAgdGhpcy5hZGFwdGVyLmVuc3VyZUF1dGhEYXRhVW5pcXVlbmVzcyhwcm92aWRlcikuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgICAgICAgIGBVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIGF1dGggZGF0YSBwcm92aWRlciBcIiR7cHJvdmlkZXJ9XCI6IGAsXG4gICAgICAgICAgICAgIGVycm9yXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgIClcbiAgICAgICk7XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5hZGFwdGVyLnVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzKCk7XG4gIH1cblxuICBfZXhwYW5kUmVzdWx0T25LZXlQYXRoKG9iamVjdDogYW55LCBrZXk6IHN0cmluZywgdmFsdWU6IGFueSk6IGFueSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCcuJykgPCAwKSB7XG4gICAgICBvYmplY3Rba2V5XSA9IHZhbHVlW2tleV07XG4gICAgICByZXR1cm4gb2JqZWN0O1xuICAgIH1cbiAgICBjb25zdCBwYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgY29uc3QgZmlyc3RLZXkgPSBwYXRoWzBdO1xuICAgIGNvbnN0IG5leHRQYXRoID0gcGF0aC5zbGljZSgxKS5qb2luKCcuJyk7XG5cbiAgICAvLyBTY2FuIHJlcXVlc3QgZGF0YSBmb3IgZGVuaWVkIGtleXdvcmRzXG4gICAgaWYgKHRoaXMub3B0aW9ucyAmJiB0aGlzLm9wdGlvbnMucmVxdWVzdEtleXdvcmREZW55bGlzdCkge1xuICAgICAgLy8gU2NhbiByZXF1ZXN0IGRhdGEgZm9yIGRlbmllZCBrZXl3b3Jkc1xuICAgICAgZm9yIChjb25zdCBrZXl3b3JkIG9mIHRoaXMub3B0aW9ucy5yZXF1ZXN0S2V5d29yZERlbnlsaXN0KSB7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gVXRpbHMub2JqZWN0Q29udGFpbnNLZXlWYWx1ZShcbiAgICAgICAgICB7IFtmaXJzdEtleV06IHRydWUsIFtuZXh0UGF0aF06IHRydWUgfSxcbiAgICAgICAgICBrZXl3b3JkLmtleSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICBgUHJvaGliaXRlZCBrZXl3b3JkIGluIHJlcXVlc3QgZGF0YTogJHtKU09OLnN0cmluZ2lmeShrZXl3b3JkKX0uYFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBPbmx5IGRlc2NlbmQgaW50byBhbiBvd24gb2JqZWN0LCBuZXZlciBhbiBpbmhlcml0ZWQgcHJvdG90eXBlIG1lbWJlclxuICAgIGNvbnN0IGNoaWxkID1cbiAgICAgIE9iamVjdC5oYXNPd24ob2JqZWN0LCBmaXJzdEtleSkgJiYgb2JqZWN0W2ZpcnN0S2V5XSAmJiB0eXBlb2Ygb2JqZWN0W2ZpcnN0S2V5XSA9PT0gJ29iamVjdCdcbiAgICAgICAgPyBvYmplY3RbZmlyc3RLZXldXG4gICAgICAgIDoge307XG4gICAgb2JqZWN0W2ZpcnN0S2V5XSA9IHRoaXMuX2V4cGFuZFJlc3VsdE9uS2V5UGF0aChjaGlsZCwgbmV4dFBhdGgsIHZhbHVlW2ZpcnN0S2V5XSk7XG4gICAgZGVsZXRlIG9iamVjdFtrZXldO1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICBfc2FuaXRpemVEYXRhYmFzZVJlc3VsdChvcmlnaW5hbE9iamVjdDogYW55LCByZXN1bHQ6IGFueSk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSB7fTtcbiAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXNwb25zZSk7XG4gICAgfVxuICAgIE9iamVjdC5rZXlzKG9yaWdpbmFsT2JqZWN0KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBjb25zdCBrZXlVcGRhdGUgPSBvcmlnaW5hbE9iamVjdFtrZXldO1xuICAgICAgLy8gZGV0ZXJtaW5lIGlmIHRoYXQgd2FzIGFuIG9wXG4gICAgICBpZiAoXG4gICAgICAgIGtleVVwZGF0ZSAmJlxuICAgICAgICB0eXBlb2Yga2V5VXBkYXRlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICBrZXlVcGRhdGUuX19vcCAmJlxuICAgICAgICBbJ0FkZCcsICdBZGRVbmlxdWUnLCAnUmVtb3ZlJywgJ0luY3JlbWVudCcsICdTZXRPbkluc2VydCddLmluZGV4T2Yoa2V5VXBkYXRlLl9fb3ApID4gLTFcbiAgICAgICkge1xuICAgICAgICAvLyBvbmx5IHZhbGlkIG9wcyB0aGF0IHByb2R1Y2UgYW4gYWN0aW9uYWJsZSByZXN1bHRcbiAgICAgICAgLy8gdGhlIG9wIG1heSBoYXZlIGhhcHBlbmVkIG9uIGEga2V5cGF0aFxuICAgICAgICB0aGlzLl9leHBhbmRSZXN1bHRPbktleVBhdGgocmVzcG9uc2UsIGtleSwgcmVzdWx0KTtcbiAgICAgICAgLy8gUmV2ZXJ0IGFycmF5IHRvIG9iamVjdCBjb252ZXJzaW9uIG9uIGRvdCBub3RhdGlvbiBmb3IgYXJyYXlzIChlLmcuIFwiZmllbGQuMC5rZXlcIilcbiAgICAgICAgaWYgKGtleS5pbmNsdWRlcygnLicpKSB7XG4gICAgICAgICAgY29uc3QgW2ZpZWxkLCBpbmRleF0gPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgICAgICBjb25zdCBpc0FycmF5SW5kZXggPSBBcnJheS5mcm9tKGluZGV4KS5ldmVyeShjID0+IGMgPj0gJzAnICYmIGMgPD0gJzknKTtcbiAgICAgICAgICBpZiAoaXNBcnJheUluZGV4ICYmIEFycmF5LmlzQXJyYXkocmVzdWx0W2ZpZWxkXSkgJiYgIUFycmF5LmlzQXJyYXkocmVzcG9uc2VbZmllbGRdKSkge1xuICAgICAgICAgICAgcmVzcG9uc2VbZmllbGRdID0gcmVzdWx0W2ZpZWxkXTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc3BvbnNlKTtcbiAgfVxuXG4gIHN0YXRpYyBfdmFsaWRhdGVRdWVyeTogKGFueSwgYm9vbGVhbiwgYm9vbGVhbiwgYm9vbGVhbikgPT4gdm9pZDtcbiAgc3RhdGljIGZpbHRlclNlbnNpdGl2ZURhdGE6IChib29sZWFuLCBib29sZWFuLCBhbnlbXSwgYW55LCBhbnksIGFueSwgc3RyaW5nLCBhbnlbXSwgYW55LCA/Ym9vbGVhbikgPT4gdm9pZDtcbiAgc3RhdGljIHZhbGlkYXRlUXVlcnlGb3JtYXQ6IGFueSA9PiB2b2lkO1xuICBzdGF0aWMgbG9naWNhbE9wZXJhdG9yRXJyb3I6IChzdHJpbmcsIGFueSkgPT4gYW55O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IERhdGFiYXNlQ29udHJvbGxlcjtcbi8vIEV4cG9zZSB2YWxpZGF0ZVF1ZXJ5IGZvciB0ZXN0c1xubW9kdWxlLmV4cG9ydHMuX3ZhbGlkYXRlUXVlcnkgPSB2YWxpZGF0ZVF1ZXJ5O1xubW9kdWxlLmV4cG9ydHMuZmlsdGVyU2Vuc2l0aXZlRGF0YSA9IGZpbHRlclNlbnNpdGl2ZURhdGE7XG5tb2R1bGUuZXhwb3J0cy52YWxpZGF0ZVF1ZXJ5Rm9ybWF0ID0gdmFsaWRhdGVRdWVyeUZvcm1hdDtcbm1vZHVsZS5leHBvcnRzLmxvZ2ljYWxPcGVyYXRvckVycm9yID0gbG9naWNhbE9wZXJhdG9yRXJyb3I7XG4iXSwibWFwcGluZ3MiOiI7O0FBS0EsSUFBQUEsS0FBQSxHQUFBQyxPQUFBO0FBRUEsSUFBQUMsT0FBQSxHQUFBQyxzQkFBQSxDQUFBRixPQUFBO0FBRUEsSUFBQUcsVUFBQSxHQUFBRCxzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQUksT0FBQSxHQUFBRixzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQUssTUFBQSxHQUFBSCxzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQU0sZ0JBQUEsR0FBQUMsdUJBQUEsQ0FBQVAsT0FBQTtBQUNBLElBQUFRLGVBQUEsR0FBQVIsT0FBQTtBQUNBLElBQUFTLG9CQUFBLEdBQUFQLHNCQUFBLENBQUFGLE9BQUE7QUFDQSxJQUFBVSx1QkFBQSxHQUFBUixzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQVcsWUFBQSxHQUFBVCxzQkFBQSxDQUFBRixPQUFBO0FBSUEsSUFBQVksTUFBQSxHQUFBWixPQUFBO0FBQWdELFNBQUFPLHdCQUFBTSxDQUFBLEVBQUFDLENBQUEsNkJBQUFDLE9BQUEsTUFBQUMsQ0FBQSxPQUFBRCxPQUFBLElBQUFFLENBQUEsT0FBQUYsT0FBQSxZQUFBUix1QkFBQSxZQUFBQSxDQUFBTSxDQUFBLEVBQUFDLENBQUEsU0FBQUEsQ0FBQSxJQUFBRCxDQUFBLElBQUFBLENBQUEsQ0FBQUssVUFBQSxTQUFBTCxDQUFBLE1BQUFNLENBQUEsRUFBQUMsQ0FBQSxFQUFBQyxDQUFBLEtBQUFDLFNBQUEsUUFBQUMsT0FBQSxFQUFBVixDQUFBLGlCQUFBQSxDQUFBLHVCQUFBQSxDQUFBLHlCQUFBQSxDQUFBLFNBQUFRLENBQUEsTUFBQUYsQ0FBQSxHQUFBTCxDQUFBLEdBQUFHLENBQUEsR0FBQUQsQ0FBQSxRQUFBRyxD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