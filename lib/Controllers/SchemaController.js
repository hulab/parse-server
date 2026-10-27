"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.VolatileClassesSchemas = exports.SchemaController = void 0;
exports.buildMergedSchemaObject = buildMergedSchemaObject;
exports.classNameIsValid = classNameIsValid;
exports.defaultColumns = exports.default = exports.convertSchemaToAdapterSchema = void 0;
exports.fieldNameIsValid = fieldNameIsValid;
exports.invalidClassNameMessage = invalidClassNameMessage;
exports.systemClasses = exports.requiredColumns = exports.load = void 0;
var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");
var _SchemaCache = _interopRequireDefault(require("../Adapters/Cache/SchemaCache"));
var _DatabaseController = _interopRequireDefault(require("./DatabaseController"));
var _Config = _interopRequireDefault(require("../Config"));
var _Error = require("../Error");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// This class handles schema validation, persistence, and modification.
//
// Each individual Schema object should be immutable. The helpers to
// do things with the Schema just return a new schema when the schema
// is changed.
//
// The canonical place to store this Schema is in the database itself,
// in a _SCHEMA collection. This is not the right way to do it for an
// open source framework, but it's backward compatible, so we're
// keeping it this way for now.
//
// In API-handling code, you should only use the Schema class via the
// DatabaseController. This will let us replace the schema logic for
// different databases.
// TODO: hide all schema logic inside the database adapter.
// -disable-next
const Parse = require('parse/node').Parse;
const defaultColumns = exports.defaultColumns = Object.freeze({
  // Contain the default columns for every parse object type (except _Join collection)
  _Default: {
    objectId: {
      type: 'String'
    },
    createdAt: {
      type: 'Date'
    },
    updatedAt: {
      type: 'Date'
    },
    ACL: {
      type: 'ACL'
    }
  },
  // The additional default columns for the _User collection (in addition to DefaultCols)
  _User: {
    username: {
      type: 'String'
    },
    password: {
      type: 'String'
    },
    email: {
      type: 'String'
    },
    emailVerified: {
      type: 'Boolean'
    },
    authData: {
      type: 'Object'
    }
  },
  // The additional default columns for the _Installation collection (in addition to DefaultCols)
  _Installation: {
    installationId: {
      type: 'String'
    },
    deviceToken: {
      type: 'String'
    },
    channels: {
      type: 'Array'
    },
    deviceType: {
      type: 'String'
    },
    pushType: {
      type: 'String'
    },
    GCMSenderId: {
      type: 'String'
    },
    timeZone: {
      type: 'String'
    },
    localeIdentifier: {
      type: 'String'
    },
    badge: {
      type: 'Number'
    },
    appVersion: {
      type: 'String'
    },
    appName: {
      type: 'String'
    },
    appIdentifier: {
      type: 'String'
    },
    parseVersion: {
      type: 'String'
    }
  },
  // The additional default columns for the _Role collection (in addition to DefaultCols)
  _Role: {
    name: {
      type: 'String'
    },
    users: {
      type: 'Relation',
      targetClass: '_User'
    },
    roles: {
      type: 'Relation',
      targetClass: '_Role'
    }
  },
  // The additional default columns for the _Session collection (in addition to DefaultCols)
  _Session: {
    user: {
      type: 'Pointer',
      targetClass: '_User'
    },
    installationId: {
      type: 'String'
    },
    sessionToken: {
      type: 'String'
    },
    expiresAt: {
      type: 'Date'
    },
    createdWith: {
      type: 'Object'
    }
  },
  _Product: {
    productIdentifier: {
      type: 'String'
    },
    download: {
      type: 'File'
    },
    downloadName: {
      type: 'String'
    },
    icon: {
      type: 'File'
    },
    order: {
      type: 'Number'
    },
    title: {
      type: 'String'
    },
    subtitle: {
      type: 'String'
    }
  },
  _PushStatus: {
    pushTime: {
      type: 'String'
    },
    source: {
      type: 'String'
    },
    // rest or webui
    query: {
      type: 'String'
    },
    // the stringified JSON query
    payload: {
      type: 'String'
    },
    // the stringified JSON payload,
    title: {
      type: 'String'
    },
    expiry: {
      type: 'Number'
    },
    expiration_interval: {
      type: 'Number'
    },
    status: {
      type: 'String'
    },
    numSent: {
      type: 'Number'
    },
    numFailed: {
      type: 'Number'
    },
    pushHash: {
      type: 'String'
    },
    errorMessage: {
      type: 'Object'
    },
    sentPerType: {
      type: 'Object'
    },
    failedPerType: {
      type: 'Object'
    },
    sentPerUTCOffset: {
      type: 'Object'
    },
    failedPerUTCOffset: {
      type: 'Object'
    },
    count: {
      type: 'Number'
    } // tracks # of batches queued and pending
  },
  _JobStatus: {
    jobName: {
      type: 'String'
    },
    source: {
      type: 'String'
    },
    status: {
      type: 'String'
    },
    message: {
      type: 'String'
    },
    params: {
      type: 'Object'
    },
    // params received when calling the job
    finishedAt: {
      type: 'Date'
    }
  },
  _JobSchedule: {
    jobName: {
      type: 'String'
    },
    description: {
      type: 'String'
    },
    params: {
      type: 'String'
    },
    startAfter: {
      type: 'String'
    },
    daysOfWeek: {
      type: 'Array'
    },
    timeOfDay: {
      type: 'String'
    },
    lastRun: {
      type: 'Number'
    },
    repeatMinutes: {
      type: 'Number'
    }
  },
  _Hooks: {
    functionName: {
      type: 'String'
    },
    className: {
      type: 'String'
    },
    triggerName: {
      type: 'String'
    },
    url: {
      type: 'String'
    }
  },
  _GlobalConfig: {
    objectId: {
      type: 'String'
    },
    params: {
      type: 'Object'
    },
    masterKeyOnly: {
      type: 'Object'
    }
  },
  _GraphQLConfig: {
    objectId: {
      type: 'String'
    },
    config: {
      type: 'Object'
    }
  },
  _Audience: {
    objectId: {
      type: 'String'
    },
    name: {
      type: 'String'
    },
    query: {
      type: 'String'
    },
    //storing query as JSON string to prevent "Nested keys should not contain the '$' or '.' characters" error
    lastUsed: {
      type: 'Date'
    },
    timesUsed: {
      type: 'Number'
    }
  },
  _Idempotency: {
    reqId: {
      type: 'String'
    },
    expire: {
      type: 'Date'
    }
  }
});

// fields required for read or write operations on their respective classes.
const requiredColumns = exports.requiredColumns = Object.freeze({
  read: {
    _User: ['username']
  },
  write: {
    _Product: ['productIdentifier', 'icon', 'order', 'title', 'subtitle'],
    _Role: ['name', 'ACL']
  }
});
const invalidColumns = ['length'];
const systemClasses = exports.systemClasses = Object.freeze(['_User', '_Installation', '_Role', '_Session', '_Product', '_PushStatus', '_JobStatus', '_JobSchedule', '_Audience', '_Idempotency']);
const volatileClasses = Object.freeze(['_JobStatus', '_PushStatus', '_Hooks', '_GlobalConfig', '_GraphQLConfig', '_JobSchedule', '_Audience', '_Idempotency']);

// Anything that start with role
const roleRegex = /^role:.*/;
// Anything that starts with userField (allowed for protected fields only)
const protectedFieldsPointerRegex = /^userField:.*/;
// * permission
const publicRegex = /^\*$/;
const authenticatedRegex = /^authenticated$/;
const requiresAuthenticationRegex = /^requiresAuthentication$/;
const clpPointerRegex = /^pointerFields$/;

// regex for validating entities in protectedFields object
const protectedFieldsRegex = Object.freeze([protectedFieldsPointerRegex, publicRegex, authenticatedRegex, roleRegex]);

// clp regex
const clpFieldsRegex = Object.freeze([clpPointerRegex, publicRegex, requiresAuthenticationRegex, roleRegex]);
function validatePermissionKey(key, userIdRegExp) {
  let matchesSome = false;
  for (const regEx of clpFieldsRegex) {
    if (key.match(regEx) !== null) {
      matchesSome = true;
      break;
    }
  }

  // userId depends on startup options so it's dynamic
  const valid = matchesSome || key.match(userIdRegExp) !== null;
  if (!valid) {
    throw new Parse.Error(Parse.Error.INVALID_JSON, `'${key}' is not a valid key for class level permissions`);
  }
}
function validateProtectedFieldsKey(key, userIdRegExp) {
  let matchesSome = false;
  for (const regEx of protectedFieldsRegex) {
    if (key.match(regEx) !== null) {
      matchesSome = true;
      break;
    }
  }

  // userId regex depends on launch options so it's dynamic
  const valid = matchesSome || key.match(userIdRegExp) !== null;
  if (!valid) {
    throw new Parse.Error(Parse.Error.INVALID_JSON, `'${key}' is not a valid key for class level permissions`);
  }
}
const CLPValidKeys = Object.freeze(['ACL', 'find', 'count', 'get', 'create', 'update', 'delete', 'addField', 'readUserFields', 'writeUserFields', 'protectedFields']);

// validation before setting class-level permissions on collection
function validateCLP(perms, fields, userIdRegExp) {
  if (!perms) {
    return;
  }
  for (const operationKey in perms) {
    if (CLPValidKeys.indexOf(operationKey) == -1) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, `${operationKey} is not a valid operation for class level permissions`);
    }
    const operation = perms[operationKey];
    // proceed with next operationKey

    // throws when root fields are of wrong type
    validateCLPjson(operation, operationKey);
    if (operationKey === 'readUserFields' || operationKey === 'writeUserFields') {
      // validate grouped pointer permissions
      // must be an array with field names
      for (const fieldName of operation) {
        validatePointerPermission(fieldName, fields, operationKey);
      }
      // readUserFields and writerUserFields do not have nesdted fields
      // proceed with next operationKey
      continue;
    }

    // validate protected fields
    if (operationKey === 'protectedFields') {
      for (const entity in operation) {
        // throws on unexpected key
        validateProtectedFieldsKey(entity, userIdRegExp);
        const protectedFields = operation[entity];
        if (!Array.isArray(protectedFields)) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `'${protectedFields}' is not a valid value for protectedFields[${entity}] - expected an array.`);
        }

        // if the field is in form of array
        for (const field of protectedFields) {
          // do not alloow to protect default fields
          if (defaultColumns._Default[field]) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `Default field '${field}' can not be protected`);
          }
          // field should exist on collection
          if (!Object.prototype.hasOwnProperty.call(fields, field)) {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `Field '${field}' in protectedFields:${entity} does not exist`);
          }
        }
      }
      // proceed with next operationKey
      continue;
    }

    // validate other fields
    // Entity can be:
    // "*" - Public,
    // "requiresAuthentication" - authenticated users,
    // "objectId" - _User id,
    // "role:rolename",
    // "pointerFields" - array of field names containing pointers to users
    for (const entity in operation) {
      // throws on unexpected key
      validatePermissionKey(entity, userIdRegExp);

      // entity can be either:
      // "pointerFields": string[]
      if (entity === 'pointerFields') {
        const pointerFields = operation[entity];
        if (Array.isArray(pointerFields)) {
          for (const pointerField of pointerFields) {
            validatePointerPermission(pointerField, fields, operation);
          }
        } else {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `'${pointerFields}' is not a valid value for ${operationKey}[${entity}] - expected an array.`);
        }
        // proceed with next entity key
        continue;
      }
      const permit = operation[entity];
      if (operationKey === 'ACL') {
        if (Object.prototype.toString.call(permit) !== '[object Object]') {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `'${permit}' is not a valid value for class level permissions acl`);
        }
        const invalidKeys = Object.keys(permit).filter(key => !['read', 'write'].includes(key));
        const invalidValues = Object.values(permit).filter(key => typeof key !== 'boolean');
        if (invalidKeys.length) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `'${invalidKeys.join(',')}' is not a valid key for class level permissions acl`);
        }
        if (invalidValues.length) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `'${invalidValues.join(',')}' is not a valid value for class level permissions acl`);
        }
      } else if (permit !== true) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, `'${permit}' is not a valid value for class level permissions acl ${operationKey}:${entity}`);
      }
    }
  }
}
function validateCLPjson(operation, operationKey) {
  if (operationKey === 'readUserFields' || operationKey === 'writeUserFields') {
    if (!Array.isArray(operation)) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, `'${operation}' is not a valid value for class level permissions ${operationKey} - must be an array`);
    }
  } else {
    if (typeof operation === 'object' && operation !== null) {
      // ok to proceed
      return;
    } else {
      throw new Parse.Error(Parse.Error.INVALID_JSON, `'${operation}' is not a valid value for class level permissions ${operationKey} - must be an object`);
    }
  }
}
function validatePointerPermission(fieldName, fields, operation) {
  // Uses collection schema to ensure the field is of type:
  // - Pointer<_User> (pointers)
  // - Array
  //
  //    It's not possible to enforce type on Array's items in schema
  //  so we accept any Array field, and later when applying permissions
  //  only items that are pointers to _User are considered.
  if (!(fields[fieldName] && (fields[fieldName].type == 'Pointer' && fields[fieldName].targetClass == '_User' || fields[fieldName].type == 'Array'))) {
    throw new Parse.Error(Parse.Error.INVALID_JSON, `'${fieldName}' is not a valid column for class level pointer permissions ${operation}`);
  }
}
const joinClassRegex = /^_Join:[A-Za-z0-9_]+:[A-Za-z0-9_]+/;
const classAndFieldRegex = /^[A-Za-z][A-Za-z0-9_]*$/;
function classNameIsValid(className) {
  // Valid classes must:
  return (
    // Be one of _User, _Installation, _Role, _Session OR
    systemClasses.indexOf(className) > -1 ||
    // Be a join table OR
    joinClassRegex.test(className) ||
    // Include only alpha-numeric and underscores, and not start with an underscore or number
    fieldNameIsValid(className, className)
  );
}

// Valid fields must be alpha-numeric, and not start with an underscore or number
// must not be a reserved key
function fieldNameIsValid(fieldName, className) {
  if (className && className !== '_Hooks') {
    if (fieldName === 'className') {
      return false;
    }
  }
  return classAndFieldRegex.test(fieldName) && !invalidColumns.includes(fieldName);
}

// Checks that it's not trying to clobber one of the default fields of the class.
function fieldNameIsValidForClass(fieldName, className) {
  if (!fieldNameIsValid(fieldName, className)) {
    return false;
  }
  if (defaultColumns._Default[fieldName]) {
    return false;
  }
  if (defaultColumns[className] && defaultColumns[className][fieldName]) {
    return false;
  }
  return true;
}
function invalidClassNameMessage(className) {
  return 'Invalid classname: ' + className + ', classnames can only have alphanumeric characters and _, and must start with an alpha character ';
}
const invalidJsonError = new Parse.Error(Parse.Error.INVALID_JSON, 'invalid JSON');
const validNonRelationOrPointerTypes = ['Number', 'String', 'Boolean', 'Date', 'Object', 'Array', 'GeoPoint', 'File', 'Bytes', 'Polygon'];
// Returns an error suitable for throwing if the type is invalid
const fieldTypeIsInvalid = ({
  type,
  targetClass
}) => {
  if (['Pointer', 'Relation'].indexOf(type) >= 0) {
    if (!targetClass) {
      return new Parse.Error(135, `type ${type} needs a class name`);
    } else if (typeof targetClass !== 'string') {
      return invalidJsonError;
    } else if (!classNameIsValid(targetClass)) {
      return new Parse.Error(Parse.Error.INVALID_CLASS_NAME, invalidClassNameMessage(targetClass));
    } else {
      return undefined;
    }
  }
  if (typeof type !== 'string') {
    return invalidJsonError;
  }
  if (validNonRelationOrPointerTypes.indexOf(type) < 0) {
    return new Parse.Error(Parse.Error.INCORRECT_TYPE, `invalid field type: ${type}`);
  }
  return undefined;
};
const convertSchemaToAdapterSchema = schema => {
  schema = injectDefaultSchema(schema);
  delete schema.fields.ACL;
  schema.fields._rperm = {
    type: 'Array'
  };
  schema.fields._wperm = {
    type: 'Array'
  };
  if (schema.className === '_User') {
    delete schema.fields.password;
    schema.fields._hashed_password = {
      type: 'String'
    };
  }
  return schema;
};
exports.convertSchemaToAdapterSchema = convertSchemaToAdapterSchema;
const convertAdapterSchemaToParseSchema = ({
  ...schema
}) => {
  delete schema.fields._rperm;
  delete schema.fields._wperm;
  schema.fields.ACL = {
    type: 'ACL'
  };
  if (schema.className === '_User') {
    delete schema.fields.authData; //Auth data is implicit
    delete schema.fields._hashed_password;
    schema.fields.password = {
      type: 'String'
    };
  }
  if (schema.indexes && Object.keys(schema.indexes).length === 0) {
    delete schema.indexes;
  }
  return schema;
};
class SchemaData {
  constructor(allSchemas = [], protectedFields = {}) {
    this.__data = {};
    this.__protectedFields = protectedFields;
    allSchemas.forEach(schema => {
      if (volatileClasses.includes(schema.className)) {
        return;
      }
      Object.defineProperty(this, schema.className, {
        get: () => {
          if (!this.__data[schema.className]) {
            const data = {};
            data.fields = injectDefaultSchema(schema).fields;
            data.classLevelPermissions = structuredClone(schema.classLevelPermissions);
            data.indexes = schema.indexes;
            const classProtectedFields = this.__protectedFields[schema.className];
            if (classProtectedFields) {
              for (const key in classProtectedFields) {
                const unq = new Set([...(data.classLevelPermissions.protectedFields[key] || []), ...classProtectedFields[key]]);
                data.classLevelPermissions.protectedFields[key] = Array.from(unq);
              }
            }
            this.__data[schema.className] = data;
          }
          return this.__data[schema.className];
        }
      });
    });

    // Inject the in-memory classes
    volatileClasses.forEach(className => {
      Object.defineProperty(this, className, {
        get: () => {
          if (!this.__data[className]) {
            const schema = injectDefaultSchema({
              className,
              fields: {},
              classLevelPermissions: {}
            });
            const data = {};
            data.fields = schema.fields;
            data.classLevelPermissions = schema.classLevelPermissions;
            data.indexes = schema.indexes;
            this.__data[className] = data;
          }
          return this.__data[className];
        }
      });
    });
  }
}
const injectDefaultSchema = ({
  className,
  fields,
  classLevelPermissions,
  indexes
}) => {
  const defaultSchema = {
    className,
    fields: {
      ...defaultColumns._Default,
      ...(defaultColumns[className] || {}),
      ...fields
    },
    classLevelPermissions
  };
  if (indexes && Object.keys(indexes).length !== 0) {
    defaultSchema.indexes = indexes;
  }
  return defaultSchema;
};
const _HooksSchema = {
  className: '_Hooks',
  fields: defaultColumns._Hooks
};
const _GlobalConfigSchema = {
  className: '_GlobalConfig',
  fields: defaultColumns._GlobalConfig
};
const _GraphQLConfigSchema = {
  className: '_GraphQLConfig',
  fields: defaultColumns._GraphQLConfig
};
const _PushStatusSchema = convertSchemaToAdapterSchema(injectDefaultSchema({
  className: '_PushStatus',
  fields: {},
  classLevelPermissions: {}
}));
const _JobStatusSchema = convertSchemaToAdapterSchema(injectDefaultSchema({
  className: '_JobStatus',
  fields: {},
  classLevelPermissions: {}
}));
const _JobScheduleSchema = convertSchemaToAdapterSchema(injectDefaultSchema({
  className: '_JobSchedule',
  fields: {},
  classLevelPermissions: {}
}));
const _AudienceSchema = convertSchemaToAdapterSchema(injectDefaultSchema({
  className: '_Audience',
  fields: defaultColumns._Audience,
  classLevelPermissions: {}
}));
const _IdempotencySchema = convertSchemaToAdapterSchema(injectDefaultSchema({
  className: '_Idempotency',
  fields: defaultColumns._Idempotency,
  classLevelPermissions: {}
}));
const VolatileClassesSchemas = exports.VolatileClassesSchemas = [_HooksSchema, _JobStatusSchema, _JobScheduleSchema, _PushStatusSchema, _GlobalConfigSchema, _GraphQLConfigSchema, _AudienceSchema, _IdempotencySchema];
const dbTypeMatchesObjectType = (dbType, objectType) => {
  if (dbType.type !== objectType.type) {
    return false;
  }
  if (dbType.targetClass !== objectType.targetClass) {
    return false;
  }
  if (dbType === objectType.type) {
    return true;
  }
  if (dbType.type === objectType.type) {
    return true;
  }
  return false;
};
const typeToString = type => {
  if (typeof type === 'string') {
    return type;
  }
  if (type.targetClass) {
    return `${type.type}<${type.targetClass}>`;
  }
  return `${type.type}`;
};
const ttl = {
  date: Date.now(),
  duration: undefined
};

// Stores the entire schema of the app in a weird hybrid format somewhere between
// the mongo format and the Parse format. Soon, this will all be Parse format.
class SchemaController {
  constructor(databaseAdapter) {
    this._dbAdapter = databaseAdapter;
    const config = _Config.default.get(Parse.applicationId);
    this.schemaData = new SchemaData(_SchemaCache.default.all(), this.protectedFields);
    this.protectedFields = config.protectedFields;
    const customIds = config.allowCustomObjectId;
    const customIdRegEx = /^.{1,}$/u; // 1+ chars
    const autoIdRegEx = /^[a-zA-Z0-9]{1,}$/;
    this.userIdRegEx = customIds ? customIdRegEx : autoIdRegEx;
    this._dbAdapter.watch(() => {
      this.reloadData({
        clearCache: true
      });
    });
  }
  async reloadDataIfNeeded() {
    if (this._dbAdapter.enableSchemaHooks) {
      return;
    }
    const {
      date,
      duration
    } = ttl || {};
    if (!duration) {
      return;
    }
    const now = Date.now();
    if (now - date > duration) {
      ttl.date = now;
      await this.reloadData({
        clearCache: true
      });
    }
  }
  reloadData(options = {
    clearCache: false
  }) {
    if (this.reloadDataPromise && !options.clearCache) {
      return this.reloadDataPromise;
    }
    this.reloadDataPromise = this.getAllClasses(options).then(allSchemas => {
      this.schemaData = new SchemaData(allSchemas, this.protectedFields);
      delete this.reloadDataPromise;
    }, err => {
      this.schemaData = new SchemaData();
      delete this.reloadDataPromise;
      throw err;
    }).then(() => {});
    return this.reloadDataPromise;
  }
  async getAllClasses(options = {
    clearCache: false
  }) {
    if (options.clearCache) {
      return this.setAllClasses();
    }
    await this.reloadDataIfNeeded();
    const cached = _SchemaCache.default.all();
    if (cached && cached.length) {
      return Promise.resolve(cached);
    }
    return this.setAllClasses();
  }
  setAllClasses() {
    return this._dbAdapter.getAllClasses().then(allSchemas => allSchemas.map(injectDefaultSchema)).then(allSchemas => {
      _SchemaCache.default.put(allSchemas);
      return allSchemas;
    });
  }
  getOneSchema(className, allowVolatileClasses = false, options = {
    clearCache: false
  }) {
    if (options.clearCache) {
      _SchemaCache.default.clear();
    }
    if (allowVolatileClasses && volatileClasses.indexOf(className) > -1) {
      const data = this.schemaData[className];
      return Promise.resolve({
        className,
        fields: data.fields,
        classLevelPermissions: data.classLevelPermissions,
        indexes: data.indexes
      });
    }
    const cached = _SchemaCache.default.get(className);
    if (cached && !options.clearCache) {
      return Promise.resolve(cached);
    }
    return this.setAllClasses().then(allSchemas => {
      const oneSchema = allSchemas.find(schema => schema.className === className);
      if (!oneSchema) {
        return Promise.reject(undefined);
      }
      return oneSchema;
    });
  }

  // Create a new class that includes the three default fields.
  // ACL is an implicit column that does not get an entry in the
  // _SCHEMAS database. Returns a promise that resolves with the
  // created schema, in mongo format.
  // on success, and rejects with an error on fail. Ensure you
  // have authorization (master key, or client class creation
  // enabled) before calling this function.
  async addClassIfNotExists(className, fields = {}, classLevelPermissions, indexes = {}) {
    var validationError = this.validateNewClass(className, fields, classLevelPermissions);
    if (validationError) {
      if (validationError instanceof Parse.Error) {
        return Promise.reject(validationError);
      } else if (validationError.code && validationError.error) {
        return Promise.reject(new Parse.Error(validationError.code, validationError.error));
      }
      return Promise.reject(validationError);
    }
    try {
      const adapterSchema = await this._dbAdapter.createClass(className, convertSchemaToAdapterSchema({
        fields,
        classLevelPermissions,
        indexes,
        className
      }));
      // TODO: Remove by updating schema cache directly
      await this.reloadData({
        clearCache: true
      });
      const parseSchema = convertAdapterSchemaToParseSchema(adapterSchema);
      return parseSchema;
    } catch (error) {
      if (error && error.code === Parse.Error.DUPLICATE_VALUE) {
        throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME, `Class ${className} already exists.`);
      } else {
        throw error;
      }
    }
  }
  updateClass(className, submittedFields, classLevelPermissions, indexes, database) {
    return this.getOneSchema(className).then(schema => {
      const existingFields = schema.fields;
      Object.keys(submittedFields).forEach(name => {
        const field = submittedFields[name];
        if (existingFields[name] && existingFields[name].type !== field.type && field.__op !== 'Delete') {
          throw new Parse.Error(255, `Field ${name} exists, cannot update.`);
        }
        if (!existingFields[name] && field.__op === 'Delete') {
          throw new Parse.Error(255, `Field ${name} does not exist, cannot delete.`);
        }
      });
      delete existingFields._rperm;
      delete existingFields._wperm;
      const newSchema = buildMergedSchemaObject(existingFields, submittedFields);
      const defaultFields = defaultColumns[className] || defaultColumns._Default;
      const fullNewSchema = Object.assign({}, newSchema, defaultFields);
      const validationError = this.validateSchemaData(className, newSchema, classLevelPermissions, Object.keys(existingFields));
      if (validationError) {
        throw new Parse.Error(validationError.code, validationError.error);
      }

      // Finally we have checked to make sure the request is valid and we can start deleting fields.
      // Do all deletions first, then a single save to _SCHEMA collection to handle all additions.
      const deletedFields = [];
      const insertedFields = [];
      Object.keys(submittedFields).forEach(fieldName => {
        if (submittedFields[fieldName].__op === 'Delete') {
          deletedFields.push(fieldName);
        } else {
          insertedFields.push(fieldName);
        }
      });
      let deletePromise = Promise.resolve();
      if (deletedFields.length > 0) {
        deletePromise = this.deleteFields(deletedFields, className, database);
      }
      let enforceFields = [];
      return deletePromise // Delete Everything
      .then(() => this.reloadData({
        clearCache: true
      })) // Reload our Schema, so we have all the new values
      .then(() => {
        const promises = insertedFields.map(fieldName => {
          const type = submittedFields[fieldName];
          return this.enforceFieldExists(className, fieldName, type);
        });
        return Promise.all(promises);
      }).then(results => {
        enforceFields = results.filter(result => !!result);
        return this.setPermissions(className, classLevelPermissions, newSchema);
      }).then(() => this._dbAdapter.setIndexesWithSchemaFormat(className, indexes, schema.indexes, fullNewSchema)).then(() => this.reloadData({
        clearCache: true
      }))
      //TODO: Move this logic into the database adapter
      .then(() => {
        this.ensureFields(enforceFields);
        const schema = this.schemaData[className];
        const reloadedSchema = {
          className: className,
          fields: schema.fields,
          classLevelPermissions: schema.classLevelPermissions
        };
        if (schema.indexes && Object.keys(schema.indexes).length !== 0) {
          reloadedSchema.indexes = schema.indexes;
        }
        return reloadedSchema;
      });
    }).catch(error => {
      if (error === undefined) {
        throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME, `Class ${className} does not exist.`);
      } else {
        throw error;
      }
    });
  }

  // Returns a promise that resolves successfully to the new schema
  // object or fails with a reason.
  enforceClassExists(className) {
    if (this.schemaData[className]) {
      return Promise.resolve(this);
    }
    // We don't have this class. Update the schema
    return (
      // The schema update succeeded. Reload the schema
      this.addClassIfNotExists(className).catch(() => {
        // The schema update failed. This can be okay - it might
        // have failed because there's a race condition and a different
        // client is making the exact same schema update that we want.
        // So just reload the schema.
        return this.reloadData({
          clearCache: true
        });
      }).then(() => {
        // Ensure that the schema now validates
        if (this.schemaData[className]) {
          return this;
        } else {
          throw new Parse.Error(Parse.Error.INVALID_JSON, `Failed to add ${className}`);
        }
      }).catch(() => {
        // The schema still doesn't validate. Give up
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'schema class name does not revalidate');
      })
    );
  }
  validateNewClass(className, fields = {}, classLevelPermissions) {
    if (this.schemaData[className]) {
      throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME, `Class ${className} already exists.`);
    }
    if (!classNameIsValid(className)) {
      return {
        code: Parse.Error.INVALID_CLASS_NAME,
        error: invalidClassNameMessage(className)
      };
    }
    return this.validateSchemaData(className, fields, classLevelPermissions, []);
  }
  validateSchemaData(className, fields, classLevelPermissions, existingFieldNames) {
    for (const fieldName in fields) {
      if (existingFieldNames.indexOf(fieldName) < 0) {
        if (!fieldNameIsValid(fieldName, className)) {
          return {
            code: Parse.Error.INVALID_KEY_NAME,
            error: 'invalid field name: ' + fieldName
          };
        }
        if (!fieldNameIsValidForClass(fieldName, className)) {
          return {
            code: 136,
            error: 'field ' + fieldName + ' cannot be added'
          };
        }
        const fieldType = fields[fieldName];
        const error = fieldTypeIsInvalid(fieldType);
        if (error) {
          return {
            code: error.code,
            error: error.message
          };
        }
        if (fieldType.defaultValue !== undefined) {
          let defaultValueType = getType(fieldType.defaultValue);
          if (typeof defaultValueType === 'string') {
            defaultValueType = {
              type: defaultValueType
            };
          } else if (typeof defaultValueType === 'object' && fieldType.type === 'Relation') {
            return {
              code: Parse.Error.INCORRECT_TYPE,
              error: `The 'default value' option is not applicable for ${typeToString(fieldType)}`
            };
          }
          if (!dbTypeMatchesObjectType(fieldType, defaultValueType)) {
            return {
              code: Parse.Error.INCORRECT_TYPE,
              error: `schema mismatch for ${className}.${fieldName} default value; expected ${typeToString(fieldType)} but got ${typeToString(defaultValueType)}`
            };
          }
        } else if (fieldType.required) {
          if (typeof fieldType === 'object' && fieldType.type === 'Relation') {
            return {
              code: Parse.Error.INCORRECT_TYPE,
              error: `The 'required' option is not applicable for ${typeToString(fieldType)}`
            };
          }
        }
      }
    }
    for (const fieldName in defaultColumns[className]) {
      fields[fieldName] = defaultColumns[className][fieldName];
    }
    const geoPoints = Object.keys(fields).filter(key => fields[key] && fields[key].type === 'GeoPoint');
    if (geoPoints.length > 1) {
      return {
        code: Parse.Error.INCORRECT_TYPE,
        error: 'currently, only one GeoPoint field may exist in an object. Adding ' + geoPoints[1] + ' when ' + geoPoints[0] + ' already exists.'
      };
    }
    validateCLP(classLevelPermissions, fields, this.userIdRegEx);
  }

  // Sets the Class-level permissions for a given className, which must exist.
  async setPermissions(className, perms, newSchema) {
    if (typeof perms === 'undefined') {
      return Promise.resolve();
    }
    validateCLP(perms, newSchema, this.userIdRegEx);
    await this._dbAdapter.setClassLevelPermissions(className, perms);
    const cached = _SchemaCache.default.get(className);
    if (cached) {
      cached.classLevelPermissions = perms;
    }
  }

  // Returns a promise that resolves successfully to the new schema
  // object if the provided className-fieldName-type tuple is valid.
  // The className must already be validated.
  // If 'freeze' is true, refuse to update the schema for this field.
  enforceFieldExists(className, fieldName, type, isValidation, maintenance) {
    if (fieldName.indexOf('.') > 0) {
      // "<array>.<index>" for Nested Arrays
      // "<embedded document>.<field>" for Nested Objects
      // JSON Arrays are treated as Nested Objects
      const [x, y] = fieldName.split('.');
      fieldName = x;
      const isArrayIndex = Array.from(y).every(c => c >= '0' && c <= '9');
      if (isArrayIndex && !['sentPerUTCOffset', 'failedPerUTCOffset'].includes(fieldName)) {
        type = 'Array';
      } else {
        type = 'Object';
      }
    }
    let fieldNameToValidate = `${fieldName}`;
    if (maintenance && fieldNameToValidate.charAt(0) === '_') {
      fieldNameToValidate = fieldNameToValidate.substring(1);
    }
    if (!fieldNameIsValid(fieldNameToValidate, className)) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
    }

    // If someone tries to create a new field with null/undefined as the value, return;
    if (!type) {
      return undefined;
    }
    const expectedType = this.getExpectedType(className, fieldName);
    if (typeof type === 'string') {
      type = {
        type
      };
    }
    if (type.defaultValue !== undefined) {
      let defaultValueType = getType(type.defaultValue);
      if (typeof defaultValueType === 'string') {
        defaultValueType = {
          type: defaultValueType
        };
      }
      if (!dbTypeMatchesObjectType(type, defaultValueType)) {
        throw new Parse.Error(Parse.Error.INCORRECT_TYPE, `schema mismatch for ${className}.${fieldName} default value; expected ${typeToString(type)} but got ${typeToString(defaultValueType)}`);
      }
    }
    if (expectedType) {
      if (!dbTypeMatchesObjectType(expectedType, type)) {
        throw new Parse.Error(Parse.Error.INCORRECT_TYPE, `schema mismatch for ${className}.${fieldName}; expected ${typeToString(expectedType)} but got ${typeToString(type)}`);
      }
      // If type options do not change
      // we can safely return
      if (isValidation || JSON.stringify(expectedType) === JSON.stringify(type)) {
        return undefined;
      }
      // Field options are may be changed
      // ensure to have an update to date schema field
      return this._dbAdapter.updateFieldOptions(className, fieldName, type);
    }
    return this._dbAdapter.addFieldIfNotExists(className, fieldName, type).catch(error => {
      if (error.code == Parse.Error.INCORRECT_TYPE) {
        // Make sure that we throw errors when it is appropriate to do so.
        throw error;
      }
      // The update failed. This can be okay - it might have been a race
      // condition where another client updated the schema in the same
      // way that we wanted to. So, just reload the schema
      return Promise.resolve();
    }).then(() => {
      return {
        className,
        fieldName,
        type
      };
    });
  }
  ensureFields(fields) {
    for (let i = 0; i < fields.length; i += 1) {
      const {
        className,
        fieldName
      } = fields[i];
      let {
        type
      } = fields[i];
      const expectedType = this.getExpectedType(className, fieldName);
      if (typeof type === 'string') {
        type = {
          type: type
        };
      }
      if (!expectedType || !dbTypeMatchesObjectType(expectedType, type)) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, `Could not add field ${fieldName}`);
      }
    }
  }

  // maintain compatibility
  deleteField(fieldName, className, database) {
    return this.deleteFields([fieldName], className, database);
  }

  // Delete fields, and remove that data from all objects. This is intended
  // to remove unused fields, if other writers are writing objects that include
  // this field, the field may reappear. Returns a Promise that resolves with
  // no object on success, or rejects with { code, error } on failure.
  // Passing the database and prefix is necessary in order to drop relation collections
  // and remove fields from objects. Ideally the database would belong to
  // a database adapter and this function would close over it or access it via member.
  deleteFields(fieldNames, className, database) {
    if (!classNameIsValid(className)) {
      throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME, invalidClassNameMessage(className));
    }
    fieldNames.forEach(fieldName => {
      if (!fieldNameIsValid(fieldName, className)) {
        throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `invalid field name: ${fieldName}`);
      }
      //Don't allow deleting the default fields.
      if (!fieldNameIsValidForClass(fieldName, className)) {
        throw new Parse.Error(136, `field ${fieldName} cannot be changed`);
      }
    });
    return this.getOneSchema(className, false, {
      clearCache: true
    }).catch(error => {
      if (error === undefined) {
        throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME, `Class ${className} does not exist.`);
      } else {
        throw error;
      }
    }).then(schema => {
      fieldNames.forEach(fieldName => {
        if (!schema.fields[fieldName]) {
          throw new Parse.Error(255, `Field ${fieldName} does not exist, cannot delete.`);
        }
      });
      const schemaFields = {
        ...schema.fields
      };
      return database.adapter.deleteFields(className, schema, fieldNames).then(() => {
        return Promise.all(fieldNames.map(fieldName => {
          const field = schemaFields[fieldName];
          if (field && field.type === 'Relation') {
            //For relations, drop the _Join table
            return database.adapter.deleteClass(`_Join:${fieldName}:${className}`);
          }
          return Promise.resolve();
        }));
      });
    }).then(() => {
      _SchemaCache.default.clear();
    });
  }

  // Validates an object provided in REST format.
  // Returns a promise that resolves to the new schema if this object is
  // valid.
  async validateObject(className, object, query, maintenance) {
    let geocount = 0;
    const schema = await this.enforceClassExists(className);
    const promises = [];
    for (const fieldName in object) {
      if (object[fieldName] && getType(object[fieldName]) === 'GeoPoint') {
        geocount++;
      }
      if (geocount > 1) {
        return Promise.reject(new Parse.Error(Parse.Error.INCORRECT_TYPE, 'there can only be one geopoint field in a class'));
      }
    }
    for (const fieldName in object) {
      if (object[fieldName] === undefined) {
        continue;
      }
      const expected = getType(object[fieldName]);
      // A null value and a Delete op have no type, which skips enforceFieldExists and
      // with it the rule that a dot notation key's parent must be an Object or Array
      // field. A null value below a non-object field (e.g. a Pointer) is then written
      // as a sub-document and corrupts the field, so still validate it as for a typed
      // value. A Delete only removes a sub-path and is a no-op here.
      const isNullDotNotationKey = object[fieldName] === null && fieldName.indexOf('.') > 0;
      if (!expected && !isNullDotNotationKey) {
        continue;
      }
      if (fieldName === 'ACL') {
        // Every object has ACL implicitly.
        continue;
      }
      promises.push(schema.enforceFieldExists(className, fieldName, expected, true, maintenance));
    }
    const results = await Promise.all(promises);
    const enforceFields = results.filter(result => !!result);
    if (enforceFields.length !== 0) {
      // TODO: Remove by updating schema cache directly
      await this.reloadData({
        clearCache: true
      });
    }
    this.ensureFields(enforceFields);
    const promise = Promise.resolve(schema);
    return thenValidateRequiredColumns(promise, className, object, query);
  }

  // Validates that all the properties are set for the object
  validateRequiredColumns(className, object, query) {
    const columns = requiredColumns.write[className];
    if (!columns || columns.length == 0) {
      return Promise.resolve(this);
    }
    const missingColumns = columns.filter(function (column) {
      if (query && query.objectId) {
        if (object[column] && typeof object[column] === 'object') {
          // Trying to delete a required column
          return object[column].__op == 'Delete';
        }
        // Not trying to do anything there
        return false;
      }
      return !object[column];
    });
    if (missingColumns.length > 0) {
      throw new Parse.Error(Parse.Error.INCORRECT_TYPE, missingColumns[0] + ' is required.');
    }
    return Promise.resolve(this);
  }
  testPermissionsForClassName(className, aclGroup, operation) {
    return SchemaController.testPermissions(this.getClassLevelPermissions(className), aclGroup, operation);
  }

  // Tests that the class level permission let pass the operation for a given aclGroup
  static testPermissions(classPermissions, aclGroup, operation) {
    if (!classPermissions || !classPermissions[operation]) {
      return true;
    }
    const perms = classPermissions[operation];
    if (perms['*']) {
      return true;
    }
    // Check permissions against the aclGroup provided (array of userId/roles)
    if (aclGroup.some(acl => {
      return perms[acl] === true;
    })) {
      return true;
    }
    return false;
  }

  // The denial of an operation by the class-level permissions, or undefined if they let it pass
  static permissionDenial(classPermissions, className, aclGroup, operation, action) {
    if (SchemaController.testPermissions(classPermissions, aclGroup, operation)) {
      return;
    }
    const perms = classPermissions[operation];
    // If only for authenticated users
    // make sure we have an aclGroup
    if (perms['requiresAuthentication']) {
      // If aclGroup has * (public)
      if (!aclGroup || aclGroup.length == 0 || aclGroup.indexOf('*') > -1 && aclGroup.length == 1) {
        return {
          code: Parse.Error.OBJECT_NOT_FOUND,
          message: 'Permission denied, user needs to be authenticated.'
        };
      }
      // requiresAuthentication passed, just move forward
      // probably would be wise at some point to rename to 'authenticatedUser'
      return;
    }
    const forbidden = {
      code: Parse.Error.OPERATION_FORBIDDEN,
      message: `Permission denied for action ${operation} on class ${className}.`
    };

    // No matching CLP, let's check the Pointer permissions
    // And handle those later
    const permissionField = ['get', 'find', 'count'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';

    // Reject create when write lockdown
    if (permissionField == 'writeUserFields' && operation == 'create') {
      return forbidden;
    }

    // Process the readUserFields later
    if (Array.isArray(classPermissions[permissionField]) && classPermissions[permissionField].length > 0) {
      return;
    }
    const pointerFields = classPermissions[operation].pointerFields;
    if (Array.isArray(pointerFields) && pointerFields.length > 0) {
      // any op except 'addField as part of create' is ok.
      if (operation !== 'addField' || action === 'update') {
        // We can allow adding field on update flow only.
        return;
      }
    }
    return forbidden;
  }

  // Validates an operation passes class-level-permissions set in the schema
  static validatePermission(classPermissions, className, aclGroup, operation, action) {
    const denial = SchemaController.permissionDenial(classPermissions, className, aclGroup, operation, action);
    if (denial) {
      throw (0, _Error.createSanitizedError)(denial.code, denial.message, _Config.default.get(Parse.applicationId));
    }
    return Promise.resolve();
  }

  // Tests that the pointer permissions of an operation let the user access the object
  static testPointerPermissions(classPermissions, aclGroup, operation, userId, getValue) {
    if (!classPermissions) {
      return true;
    }
    const permissionField = ['get', 'find', 'count'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const pointerFields = [];
    if (classPermissions[operation]?.pointerFields) {
      pointerFields.push(...classPermissions[operation].pointerFields);
    }
    if (Array.isArray(classPermissions[permissionField])) {
      for (const field of classPermissions[permissionField]) {
        if (!pointerFields.includes(field)) {
          pointerFields.push(field);
        }
      }
    }
    // A public or user-specific permission grants access without a pointer
    if (!pointerFields.length || SchemaController.testPermissions(classPermissions, aclGroup, operation)) {
      return true;
    }
    if (!userId) {
      return false;
    }
    // A pointer to the user, as a Parse.Object or in JSON
    const pointsToUser = value => value instanceof Parse.Object ? value.className === '_User' && value.id === userId : value?.__type === 'Pointer' && value.className === '_User' && value.objectId === userId;
    return pointerFields.some(field => {
      const value = getValue(field);
      return Array.isArray(value) ? value.some(pointsToUser) : pointsToUser(value);
    });
  }

  // Validates an operation passes class-level-permissions set in the schema
  validatePermission(className, aclGroup, operation, action) {
    return SchemaController.validatePermission(this.getClassLevelPermissions(className), className, aclGroup, operation, action);
  }
  getClassLevelPermissions(className) {
    return this.schemaData[className] && this.schemaData[className].classLevelPermissions;
  }

  // Returns the expected type for a className+key combination
  // or undefined if the schema is not set
  getExpectedType(className, fieldName) {
    if (this.schemaData[className]) {
      const expectedType = this.schemaData[className].fields[fieldName];
      return expectedType === 'map' ? 'Object' : expectedType;
    }
    return undefined;
  }

  // Checks if a given class is in the schema.
  hasClass(className) {
    if (this.schemaData[className]) {
      return Promise.resolve(true);
    }
    return this.reloadData().then(() => !!this.schemaData[className]);
  }
}

// Returns a promise for a new Schema.
exports.SchemaController = exports.default = SchemaController;
const load = (dbAdapter, options) => {
  const schema = new SchemaController(dbAdapter);
  ttl.duration = dbAdapter.schemaCacheTtl;
  return schema.reloadData(options).then(() => schema);
};

// Builds a new schema (in schema API response format) out of an
// existing mongo schema + a schemas API put request. This response
// does not include the default fields, as it is intended to be passed
// to mongoSchemaFromFieldsAndClassName. No validation is done here, it
// is done in mongoSchemaFromFieldsAndClassName.
exports.load = load;
function buildMergedSchemaObject(existingFields, putRequest) {
  const newSchema = {};
  // -disable-next
  const sysSchemaField = Object.keys(defaultColumns).indexOf(existingFields._id) === -1 ? [] : Object.keys(defaultColumns[existingFields._id]);
  for (const oldField in existingFields) {
    if (oldField !== '_id' && oldField !== 'ACL' && oldField !== 'updatedAt' && oldField !== 'createdAt' && oldField !== 'objectId') {
      if (sysSchemaField.length > 0 && sysSchemaField.indexOf(oldField) !== -1) {
        continue;
      }
      const fieldIsDeleted = putRequest[oldField] && putRequest[oldField].__op === 'Delete';
      if (!fieldIsDeleted) {
        newSchema[oldField] = existingFields[oldField];
      }
    }
  }
  for (const newField in putRequest) {
    if (newField !== 'objectId' && putRequest[newField].__op !== 'Delete') {
      if (sysSchemaField.length > 0 && sysSchemaField.indexOf(newField) !== -1) {
        continue;
      }
      newSchema[newField] = putRequest[newField];
    }
  }
  return newSchema;
}

// Given a schema promise, construct another schema promise that
// validates this field once the schema loads.
function thenValidateRequiredColumns(schemaPromise, className, object, query) {
  return schemaPromise.then(schema => {
    return schema.validateRequiredColumns(className, object, query);
  });
}

// Gets the type from a REST API formatted object, where 'type' is
// extended past javascript types to include the rest of the Parse
// type system.
// The output should be a valid schema value.
// TODO: ensure that this is compatible with the format used in Open DB
function getType(obj) {
  const type = typeof obj;
  switch (type) {
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'number':
      return 'Number';
    case 'map':
    case 'object':
      if (!obj) {
        return undefined;
      }
      return getObjectType(obj);
    case 'function':
    case 'symbol':
    case 'undefined':
    default:
      throw 'bad obj: ' + obj;
  }
}

// This gets the type for non-JSON types like pointers and files, but
// also gets the appropriate type for $ operators.
// Returns null if the type is unknown.
function getObjectType(obj) {
  if (Array.isArray(obj)) {
    return 'Array';
  }
  if (obj.__type) {
    switch (obj.__type) {
      case 'Pointer':
        if (obj.className) {
          return {
            type: 'Pointer',
            targetClass: obj.className
          };
        }
        break;
      case 'Relation':
        if (obj.className) {
          return {
            type: 'Relation',
            targetClass: obj.className
          };
        }
        break;
      case 'File':
        if (obj.name) {
          return 'File';
        }
        break;
      case 'Date':
        if (obj.iso) {
          return 'Date';
        }
        break;
      case 'GeoPoint':
        if (obj.latitude != null && obj.longitude != null) {
          return 'GeoPoint';
        }
        break;
      case 'Bytes':
        if (obj.base64) {
          return 'Bytes';
        }
        break;
      case 'Polygon':
        if (obj.coordinates) {
          return 'Polygon';
        }
        break;
    }
    throw new Parse.Error(Parse.Error.INCORRECT_TYPE, 'This is not a valid ' + obj.__type);
  }
  if (obj['$ne']) {
    return getObjectType(obj['$ne']);
  }
  if (obj.__op) {
    switch (obj.__op) {
      case 'Increment':
        return 'Number';
      case 'Delete':
        return null;
      case 'Add':
      case 'AddUnique':
      case 'Remove':
        return 'Array';
      case 'AddRelation':
      case 'RemoveRelation':
        return {
          type: 'Relation',
          targetClass: obj.objects[0].className
        };
      case 'Batch':
        return getObjectType(obj.ops[0]);
      default:
        throw 'unexpected op: ' + obj.__op;
    }
  }
  return 'Object';
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfU3RvcmFnZUFkYXB0ZXIiLCJyZXF1aXJlIiwiX1NjaGVtYUNhY2hlIiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsIl9EYXRhYmFzZUNvbnRyb2xsZXIiLCJfQ29uZmlnIiwiX0Vycm9yIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiUGFyc2UiLCJkZWZhdWx0Q29sdW1ucyIsImV4cG9ydHMiLCJPYmplY3QiLCJmcmVlemUiLCJfRGVmYXVsdCIsIm9iamVjdElkIiwidHlwZSIsImNyZWF0ZWRBdCIsInVwZGF0ZWRBdCIsIkFDTCIsIl9Vc2VyIiwidXNlcm5hbWUiLCJwYXNzd29yZCIsImVtYWlsIiwiZW1haWxWZXJpZmllZCIsImF1dGhEYXRhIiwiX0luc3RhbGxhdGlvbiIsImluc3RhbGxhdGlvbklkIiwiZGV2aWNlVG9rZW4iLCJjaGFubmVscyIsImRldmljZVR5cGUiLCJwdXNoVHlwZSIsIkdDTVNlbmRlcklkIiwidGltZVpvbmUiLCJsb2NhbGVJZGVudGlmaWVyIiwiYmFkZ2UiLCJhcHBWZXJzaW9uIiwiYXBwTmFtZSIsImFwcElkZW50aWZpZXIiLCJwYXJzZVZlcnNpb24iLCJfUm9sZSIsIm5hbWUiLCJ1c2VycyIsInRhcmdldENsYXNzIiwicm9sZXMiLCJfU2Vzc2lvbiIsInVzZXIiLCJzZXNzaW9uVG9rZW4iLCJleHBpcmVzQXQiLCJjcmVhdGVkV2l0aCIsIl9Qcm9kdWN0IiwicHJvZHVjdElkZW50aWZpZXIiLCJkb3dubG9hZCIsImRvd25sb2FkTmFtZSIsImljb24iLCJvcmRlciIsInRpdGxlIiwic3VidGl0bGUiLCJfUHVzaFN0YXR1cyIsInB1c2hUaW1lIiwic291cmNlIiwicXVlcnkiLCJwYXlsb2FkIiwiZXhwaXJ5IiwiZXhwaXJhdGlvbl9pbnRlcnZhbCIsInN0YXR1cyIsIm51bVNlbnQiLCJudW1GYWlsZWQiLCJwdXNoSGFzaCIsImVycm9yTWVzc2FnZSIsInNlbnRQZXJUeXBlIiwiZmFpbGVkUGVyVHlwZSIsInNlbnRQZXJVVENPZmZzZXQiLCJmYWlsZWRQZXJVVENPZmZzZXQiLCJjb3VudCIsIl9Kb2JTdGF0dXMiLCJqb2JOYW1lIiwibWVzc2FnZSIsInBhcmFtcyIsImZpbmlzaGVkQXQiLCJfSm9iU2NoZWR1bGUiLCJkZXNjcmlwdGlvbiIsInN0YXJ0QWZ0ZXIiLCJkYXlzT2ZXZWVrIiwidGltZU9mRGF5IiwibGFzdFJ1biIsInJlcGVhdE1pbnV0ZXMiLCJfSG9va3MiLCJmdW5jdGlvbk5hbWUiLCJjbGFzc05hbWUiLCJ0cmlnZ2VyTmFtZSIsInVybCIsIl9HbG9iYWxDb25maWciLCJtYXN0ZXJLZXlPbmx5IiwiX0dyYXBoUUxDb25maWciLCJjb25maWciLCJfQXVkaWVuY2UiLCJsYXN0VXNlZCIsInRpbWVzVXNlZCIsIl9JZGVtcG90ZW5jeSIsInJlcUlkIiwiZXhwaXJlIiwicmVxdWlyZWRDb2x1bW5zIiwicmVhZCIsIndyaXRlIiwiaW52YWxpZENvbHVtbnMiLCJzeXN0ZW1DbGFzc2VzIiwidm9sYXRpbGVDbGFzc2VzIiwicm9sZVJlZ2V4IiwicHJvdGVjdGVkRmllbGRzUG9pbnRlclJlZ2V4IiwicHVibGljUmVnZXgiLCJhdXRoZW50aWNhdGVkUmVnZXgiLCJyZXF1aXJlc0F1dGhlbnRpY2F0aW9uUmVnZXgiLCJjbHBQb2ludGVyUmVnZXgiLCJwcm90ZWN0ZWRGaWVsZHNSZWdleCIsImNscEZpZWxkc1JlZ2V4IiwidmFsaWRhdGVQZXJtaXNzaW9uS2V5Iiwia2V5IiwidXNlcklkUmVnRXhwIiwibWF0Y2hlc1NvbWUiLCJyZWdFeCIsIm1hdGNoIiwidmFsaWQiLCJFcnJvciIsIklOVkFMSURfSlNPTiIsInZhbGlkYXRlUHJvdGVjdGVkRmllbGRzS2V5IiwiQ0xQVmFsaWRLZXlzIiwidmFsaWRhdGVDTFAiLCJwZXJtcyIsImZpZWxkcyIsIm9wZXJhdGlvbktleSIsImluZGV4T2YiLCJvcGVyYXRpb24iLCJ2YWxpZGF0ZUNMUGpzb24iLCJmaWVsZE5hbWUiLCJ2YWxpZGF0ZVBvaW50ZXJQZXJtaXNzaW9uIiwiZW50aXR5IiwicHJvdGVjdGVkRmllbGRzIiwiQXJyYXkiLCJpc0FycmF5IiwiZmllbGQiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJwb2ludGVyRmllbGRzIiwicG9pbnRlckZpZWxkIiwicGVybWl0IiwidG9TdHJpbmciLCJpbnZhbGlkS2V5cyIsImtleXMiLCJmaWx0ZXIiLCJpbmNsdWRlcyIsImludmFsaWRWYWx1ZXMiLCJ2YWx1ZXMiLCJsZW5ndGgiLCJqb2luIiwiam9pbkNsYXNzUmVnZXgiLCJjbGFzc0FuZEZpZWxkUmVnZXgiLCJjbGFzc05hbWVJc1ZhbGlkIiwidGVzdCIsImZpZWxkTmFtZUlzVmFsaWQiLCJmaWVsZE5hbWVJc1ZhbGlkRm9yQ2xhc3MiLCJpbnZhbGlkQ2xhc3NOYW1lTWVzc2FnZSIsImludmFsaWRKc29uRXJyb3IiLCJ2YWxpZE5vblJlbGF0aW9uT3JQb2ludGVyVHlwZXMiLCJmaWVsZFR5cGVJc0ludmFsaWQiLCJJTlZBTElEX0NMQVNTX05BTUUiLCJ1bmRlZmluZWQiLCJJTkNPUlJFQ1RfVFlQRSIsImNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEiLCJzY2hlbWEiLCJpbmplY3REZWZhdWx0U2NoZW1hIiwiX3JwZXJtIiwiX3dwZXJtIiwiX2hhc2hlZF9wYXNzd29yZCIsImNvbnZlcnRBZGFwdGVyU2NoZW1hVG9QYXJzZVNjaGVtYSIsImluZGV4ZXMiLCJTY2hlbWFEYXRhIiwiY29uc3RydWN0b3IiLCJhbGxTY2hlbWFzIiwiX19kYXRhIiwiX19wcm90ZWN0ZWRGaWVsZHMiLCJmb3JFYWNoIiwiZGVmaW5lUHJvcGVydHkiLCJnZXQiLCJkYXRhIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwic3RydWN0dXJlZENsb25lIiwiY2xhc3NQcm90ZWN0ZWRGaWVsZHMiLCJ1bnEiLCJTZXQiLCJmcm9tIiwiZGVmYXVsdFNjaGVtYSIsIl9Ib29rc1NjaGVtYSIsIl9HbG9iYWxDb25maWdTY2hlbWEiLCJfR3JhcGhRTENvbmZpZ1NjaGVtYSIsIl9QdXNoU3RhdHVzU2NoZW1hIiwiX0pvYlN0YXR1c1NjaGVtYSIsIl9Kb2JTY2hlZHVsZVNjaGVtYSIsIl9BdWRpZW5jZVNjaGVtYSIsIl9JZGVtcG90ZW5jeVNjaGVtYSIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJkYlR5cGVNYXRjaGVzT2JqZWN0VHlwZSIsImRiVHlwZSIsIm9iamVjdFR5cGUiLCJ0eXBlVG9TdHJpbmciLCJ0dGwiLCJkYXRlIiwiRGF0ZSIsIm5vdyIsImR1cmF0aW9uIiwiU2NoZW1hQ29udHJvbGxlciIsImRhdGFiYXNlQWRhcHRlciIsIl9kYkFkYXB0ZXIiLCJDb25maWciLCJhcHBsaWNhdGlvbklkIiwic2NoZW1hRGF0YSIsIlNjaGVtYUNhY2hlIiwiYWxsIiwiY3VzdG9tSWRzIiwiYWxsb3dDdXN0b21PYmplY3RJZCIsImN1c3RvbUlkUmVnRXgiLCJhdXRvSWRSZWdFeCIsInVzZXJJZFJlZ0V4Iiwid2F0Y2giLCJyZWxvYWREYXRhIiwiY2xlYXJDYWNoZSIsInJlbG9hZERhdGFJZk5lZWRlZCIsImVuYWJsZVNjaGVtYUhvb2tzIiwib3B0aW9ucyIsInJlbG9hZERhdGFQcm9taXNlIiwiZ2V0QWxsQ2xhc3NlcyIsInRoZW4iLCJlcnIiLCJzZXRBbGxDbGFzc2VzIiwiY2FjaGVkIiwiUHJvbWlzZSIsInJlc29sdmUiLCJtYXAiLCJwdXQiLCJnZXRPbmVTY2hlbWEiLCJhbGxvd1ZvbGF0aWxlQ2xhc3NlcyIsImNsZWFyIiwib25lU2NoZW1hIiwiZmluZCIsInJlamVjdCIsImFkZENsYXNzSWZOb3RFeGlzdHMiLCJ2YWxpZGF0aW9uRXJyb3IiLCJ2YWxpZGF0ZU5ld0NsYXNzIiwiY29kZSIsImVycm9yIiwiYWRhcHRlclNjaGVtYSIsImNyZWF0ZUNsYXNzIiwicGFyc2VTY2hlbWEiLCJEVVBMSUNBVEVfVkFMVUUiLCJ1cGRhdGVDbGFzcyIsInN1Ym1pdHRlZEZpZWxkcyIsImRhdGFiYXNlIiwiZXhpc3RpbmdGaWVsZHMiLCJfX29wIiwibmV3U2NoZW1hIiwiYnVpbGRNZXJnZWRTY2hlbWFPYmplY3QiLCJkZWZhdWx0RmllbGRzIiwiZnVsbE5ld1NjaGVtYSIsImFzc2lnbiIsInZhbGlkYXRlU2NoZW1hRGF0YSIsImRlbGV0ZWRGaWVsZHMiLCJpbnNlcnRlZEZpZWxkcyIsInB1c2giLCJkZWxldGVQcm9taXNlIiwiZGVsZXRlRmllbGRzIiwiZW5mb3JjZUZpZWxkcyIsInByb21pc2VzIiwiZW5mb3JjZUZpZWxkRXhpc3RzIiwicmVzdWx0cyIsInJlc3VsdCIsInNldFBlcm1pc3Npb25zIiwic2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQiLCJlbnN1cmVGaWVsZHMiLCJyZWxvYWRlZFNjaGVtYSIsImNhdGNoIiwiZW5mb3JjZUNsYXNzRXhpc3RzIiwiZXhpc3RpbmdGaWVsZE5hbWVzIiwiSU5WQUxJRF9LRVlfTkFNRSIsImZpZWxkVHlwZSIsImRlZmF1bHRWYWx1ZSIsImRlZmF1bHRWYWx1ZVR5cGUiLCJnZXRUeXBlIiwicmVxdWlyZWQiLCJnZW9Qb2ludHMiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpc1ZhbGlkYXRpb24iLCJtYWludGVuYW5jZSIsIngiLCJ5Iiwic3BsaXQiLCJpc0FycmF5SW5kZXgiLCJldmVyeSIsImMiLCJmaWVsZE5hbWVUb1ZhbGlkYXRlIiwiY2hhckF0Iiwic3Vic3RyaW5nIiwiZXhwZWN0ZWRUeXBlIiwiZ2V0RXhwZWN0ZWRUeXBlIiwiSlNPTiIsInN0cmluZ2lmeSIsInVwZGF0ZUZpZWxkT3B0aW9ucyIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJpIiwiZGVsZXRlRmllbGQiLCJmaWVsZE5hbWVzIiwic2NoZW1hRmllbGRzIiwiYWRhcHRlciIsImRlbGV0ZUNsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJvYmplY3QiLCJnZW9jb3VudCIsImV4cGVjdGVkIiwiaXNOdWxsRG90Tm90YXRpb25LZXkiLCJwcm9taXNlIiwidGhlblZhbGlkYXRlUmVxdWlyZWRDb2x1bW5zIiwidmFsaWRhdGVSZXF1aXJlZENvbHVtbnMiLCJjb2x1bW5zIiwibWlzc2luZ0NvbHVtbnMiLCJjb2x1bW4iLCJ0ZXN0UGVybWlzc2lvbnNGb3JDbGFzc05hbWUiLCJhY2xHcm91cCIsInRlc3RQZXJtaXNzaW9ucyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImNsYXNzUGVybWlzc2lvbnMiLCJzb21lIiwiYWNsIiwicGVybWlzc2lvbkRlbmlhbCIsImFjdGlvbiIsIk9CSkVDVF9OT1RfRk9VTkQiLCJmb3JiaWRkZW4iLCJPUEVSQVRJT05fRk9SQklEREVOIiwicGVybWlzc2lvbkZpZWxkIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwiZGVuaWFsIiwiY3JlYXRlU2FuaXRpemVkRXJyb3IiLCJ0ZXN0UG9pbnRlclBlcm1pc3Npb25zIiwidXNlcklkIiwiZ2V0VmFsdWUiLCJwb2ludHNUb1VzZXIiLCJ2YWx1ZSIsImlkIiwiX190eXBlIiwiaGFzQ2xhc3MiLCJsb2FkIiwiZGJBZGFwdGVyIiwic2NoZW1hQ2FjaGVUdGwiLCJwdXRSZXF1ZXN0Iiwic3lzU2NoZW1hRmllbGQiLCJfaWQiLCJvbGRGaWVsZCIsImZpZWxkSXNEZWxldGVkIiwibmV3RmllbGQiLCJzY2hlbWFQcm9taXNlIiwib2JqIiwiZ2V0T2JqZWN0VHlwZSIsImlzbyIsImxhdGl0dWRlIiwibG9uZ2l0dWRlIiwiYmFzZTY0IiwiY29vcmRpbmF0ZXMiLCJvYmplY3RzIiwib3BzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbi8vIFRoaXMgY2xhc3MgaGFuZGxlcyBzY2hlbWEgdmFsaWRhdGlvbiwgcGVyc2lzdGVuY2UsIGFuZCBtb2RpZmljYXRpb24uXG4vL1xuLy8gRWFjaCBpbmRpdmlkdWFsIFNjaGVtYSBvYmplY3Qgc2hvdWxkIGJlIGltbXV0YWJsZS4gVGhlIGhlbHBlcnMgdG9cbi8vIGRvIHRoaW5ncyB3aXRoIHRoZSBTY2hlbWEganVzdCByZXR1cm4gYSBuZXcgc2NoZW1hIHdoZW4gdGhlIHNjaGVtYVxuLy8gaXMgY2hhbmdlZC5cbi8vXG4vLyBUaGUgY2Fub25pY2FsIHBsYWNlIHRvIHN0b3JlIHRoaXMgU2NoZW1hIGlzIGluIHRoZSBkYXRhYmFzZSBpdHNlbGYsXG4vLyBpbiBhIF9TQ0hFTUEgY29sbGVjdGlvbi4gVGhpcyBpcyBub3QgdGhlIHJpZ2h0IHdheSB0byBkbyBpdCBmb3IgYW5cbi8vIG9wZW4gc291cmNlIGZyYW1ld29yaywgYnV0IGl0J3MgYmFja3dhcmQgY29tcGF0aWJsZSwgc28gd2UncmVcbi8vIGtlZXBpbmcgaXQgdGhpcyB3YXkgZm9yIG5vdy5cbi8vXG4vLyBJbiBBUEktaGFuZGxpbmcgY29kZSwgeW91IHNob3VsZCBvbmx5IHVzZSB0aGUgU2NoZW1hIGNsYXNzIHZpYSB0aGVcbi8vIERhdGFiYXNlQ29udHJvbGxlci4gVGhpcyB3aWxsIGxldCB1cyByZXBsYWNlIHRoZSBzY2hlbWEgbG9naWMgZm9yXG4vLyBkaWZmZXJlbnQgZGF0YWJhc2VzLlxuLy8gVE9ETzogaGlkZSBhbGwgc2NoZW1hIGxvZ2ljIGluc2lkZSB0aGUgZGF0YWJhc2UgYWRhcHRlci5cbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuY29uc3QgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJykuUGFyc2U7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IFNjaGVtYUNhY2hlIGZyb20gJy4uL0FkYXB0ZXJzL0NhY2hlL1NjaGVtYUNhY2hlJztcbmltcG9ydCBEYXRhYmFzZUNvbnRyb2xsZXIgZnJvbSAnLi9EYXRhYmFzZUNvbnRyb2xsZXInO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IHsgY3JlYXRlU2FuaXRpemVkRXJyb3IgfSBmcm9tICcuLi9FcnJvcic7XG5pbXBvcnQgdHlwZSB7XG4gIFNjaGVtYSxcbiAgU2NoZW1hRmllbGRzLFxuICBDbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gIFNjaGVtYUZpZWxkLFxuICBMb2FkU2NoZW1hT3B0aW9ucyxcbn0gZnJvbSAnLi90eXBlcyc7XG5cbmNvbnN0IGRlZmF1bHRDb2x1bW5zOiB7IFtzdHJpbmddOiBTY2hlbWFGaWVsZHMgfSA9IE9iamVjdC5mcmVlemUoe1xuICAvLyBDb250YWluIHRoZSBkZWZhdWx0IGNvbHVtbnMgZm9yIGV2ZXJ5IHBhcnNlIG9iamVjdCB0eXBlIChleGNlcHQgX0pvaW4gY29sbGVjdGlvbilcbiAgX0RlZmF1bHQ6IHtcbiAgICBvYmplY3RJZDogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIGNyZWF0ZWRBdDogeyB0eXBlOiAnRGF0ZScgfSxcbiAgICB1cGRhdGVkQXQ6IHsgdHlwZTogJ0RhdGUnIH0sXG4gICAgQUNMOiB7IHR5cGU6ICdBQ0wnIH0sXG4gIH0sXG4gIC8vIFRoZSBhZGRpdGlvbmFsIGRlZmF1bHQgY29sdW1ucyBmb3IgdGhlIF9Vc2VyIGNvbGxlY3Rpb24gKGluIGFkZGl0aW9uIHRvIERlZmF1bHRDb2xzKVxuICBfVXNlcjoge1xuICAgIHVzZXJuYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgcGFzc3dvcmQ6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBlbWFpbDogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIGVtYWlsVmVyaWZpZWQ6IHsgdHlwZTogJ0Jvb2xlYW4nIH0sXG4gICAgYXV0aERhdGE6IHsgdHlwZTogJ09iamVjdCcgfSxcbiAgfSxcbiAgLy8gVGhlIGFkZGl0aW9uYWwgZGVmYXVsdCBjb2x1bW5zIGZvciB0aGUgX0luc3RhbGxhdGlvbiBjb2xsZWN0aW9uIChpbiBhZGRpdGlvbiB0byBEZWZhdWx0Q29scylcbiAgX0luc3RhbGxhdGlvbjoge1xuICAgIGluc3RhbGxhdGlvbklkOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgZGV2aWNlVG9rZW46IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBjaGFubmVsczogeyB0eXBlOiAnQXJyYXknIH0sXG4gICAgZGV2aWNlVHlwZTogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHB1c2hUeXBlOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgR0NNU2VuZGVySWQ6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICB0aW1lWm9uZTogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIGxvY2FsZUlkZW50aWZpZXI6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBiYWRnZTogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICAgIGFwcFZlcnNpb246IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBhcHBOYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgYXBwSWRlbnRpZmllcjogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHBhcnNlVmVyc2lvbjogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICB9LFxuICAvLyBUaGUgYWRkaXRpb25hbCBkZWZhdWx0IGNvbHVtbnMgZm9yIHRoZSBfUm9sZSBjb2xsZWN0aW9uIChpbiBhZGRpdGlvbiB0byBEZWZhdWx0Q29scylcbiAgX1JvbGU6IHtcbiAgICBuYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgdXNlcnM6IHsgdHlwZTogJ1JlbGF0aW9uJywgdGFyZ2V0Q2xhc3M6ICdfVXNlcicgfSxcbiAgICByb2xlczogeyB0eXBlOiAnUmVsYXRpb24nLCB0YXJnZXRDbGFzczogJ19Sb2xlJyB9LFxuICB9LFxuICAvLyBUaGUgYWRkaXRpb25hbCBkZWZhdWx0IGNvbHVtbnMgZm9yIHRoZSBfU2Vzc2lvbiBjb2xsZWN0aW9uIChpbiBhZGRpdGlvbiB0byBEZWZhdWx0Q29scylcbiAgX1Nlc3Npb246IHtcbiAgICB1c2VyOiB7IHR5cGU6ICdQb2ludGVyJywgdGFyZ2V0Q2xhc3M6ICdfVXNlcicgfSxcbiAgICBpbnN0YWxsYXRpb25JZDogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHNlc3Npb25Ub2tlbjogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIGV4cGlyZXNBdDogeyB0eXBlOiAnRGF0ZScgfSxcbiAgICBjcmVhdGVkV2l0aDogeyB0eXBlOiAnT2JqZWN0JyB9LFxuICB9LFxuICBfUHJvZHVjdDoge1xuICAgIHByb2R1Y3RJZGVudGlmaWVyOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgZG93bmxvYWQ6IHsgdHlwZTogJ0ZpbGUnIH0sXG4gICAgZG93bmxvYWROYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgaWNvbjogeyB0eXBlOiAnRmlsZScgfSxcbiAgICBvcmRlcjogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICAgIHRpdGxlOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgc3VidGl0bGU6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgfSxcbiAgX1B1c2hTdGF0dXM6IHtcbiAgICBwdXNoVGltZTogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHNvdXJjZTogeyB0eXBlOiAnU3RyaW5nJyB9LCAvLyByZXN0IG9yIHdlYnVpXG4gICAgcXVlcnk6IHsgdHlwZTogJ1N0cmluZycgfSwgLy8gdGhlIHN0cmluZ2lmaWVkIEpTT04gcXVlcnlcbiAgICBwYXlsb2FkOiB7IHR5cGU6ICdTdHJpbmcnIH0sIC8vIHRoZSBzdHJpbmdpZmllZCBKU09OIHBheWxvYWQsXG4gICAgdGl0bGU6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBleHBpcnk6IHsgdHlwZTogJ051bWJlcicgfSxcbiAgICBleHBpcmF0aW9uX2ludGVydmFsOiB7IHR5cGU6ICdOdW1iZXInIH0sXG4gICAgc3RhdHVzOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgbnVtU2VudDogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICAgIG51bUZhaWxlZDogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICAgIHB1c2hIYXNoOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgZXJyb3JNZXNzYWdlOiB7IHR5cGU6ICdPYmplY3QnIH0sXG4gICAgc2VudFBlclR5cGU6IHsgdHlwZTogJ09iamVjdCcgfSxcbiAgICBmYWlsZWRQZXJUeXBlOiB7IHR5cGU6ICdPYmplY3QnIH0sXG4gICAgc2VudFBlclVUQ09mZnNldDogeyB0eXBlOiAnT2JqZWN0JyB9LFxuICAgIGZhaWxlZFBlclVUQ09mZnNldDogeyB0eXBlOiAnT2JqZWN0JyB9LFxuICAgIGNvdW50OiB7IHR5cGU6ICdOdW1iZXInIH0sIC8vIHRyYWNrcyAjIG9mIGJhdGNoZXMgcXVldWVkIGFuZCBwZW5kaW5nXG4gIH0sXG4gIF9Kb2JTdGF0dXM6IHtcbiAgICBqb2JOYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgc291cmNlOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgc3RhdHVzOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgbWVzc2FnZTogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHBhcmFtczogeyB0eXBlOiAnT2JqZWN0JyB9LCAvLyBwYXJhbXMgcmVjZWl2ZWQgd2hlbiBjYWxsaW5nIHRoZSBqb2JcbiAgICBmaW5pc2hlZEF0OiB7IHR5cGU6ICdEYXRlJyB9LFxuICB9LFxuICBfSm9iU2NoZWR1bGU6IHtcbiAgICBqb2JOYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgZGVzY3JpcHRpb246IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBwYXJhbXM6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICBzdGFydEFmdGVyOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgZGF5c09mV2VlazogeyB0eXBlOiAnQXJyYXknIH0sXG4gICAgdGltZU9mRGF5OiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgbGFzdFJ1bjogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICAgIHJlcGVhdE1pbnV0ZXM6IHsgdHlwZTogJ051bWJlcicgfSxcbiAgfSxcbiAgX0hvb2tzOiB7XG4gICAgZnVuY3Rpb25OYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgY2xhc3NOYW1lOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgdHJpZ2dlck5hbWU6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgICB1cmw6IHsgdHlwZTogJ1N0cmluZycgfSxcbiAgfSxcbiAgX0dsb2JhbENvbmZpZzoge1xuICAgIG9iamVjdElkOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgcGFyYW1zOiB7IHR5cGU6ICdPYmplY3QnIH0sXG4gICAgbWFzdGVyS2V5T25seTogeyB0eXBlOiAnT2JqZWN0JyB9LFxuICB9LFxuICBfR3JhcGhRTENvbmZpZzoge1xuICAgIG9iamVjdElkOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgY29uZmlnOiB7IHR5cGU6ICdPYmplY3QnIH0sXG4gIH0sXG4gIF9BdWRpZW5jZToge1xuICAgIG9iamVjdElkOiB7IHR5cGU6ICdTdHJpbmcnIH0sXG4gICAgbmFtZTogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIHF1ZXJ5OiB7IHR5cGU6ICdTdHJpbmcnIH0sIC8vc3RvcmluZyBxdWVyeSBhcyBKU09OIHN0cmluZyB0byBwcmV2ZW50IFwiTmVzdGVkIGtleXMgc2hvdWxkIG5vdCBjb250YWluIHRoZSAnJCcgb3IgJy4nIGNoYXJhY3RlcnNcIiBlcnJvclxuICAgIGxhc3RVc2VkOiB7IHR5cGU6ICdEYXRlJyB9LFxuICAgIHRpbWVzVXNlZDogeyB0eXBlOiAnTnVtYmVyJyB9LFxuICB9LFxuICBfSWRlbXBvdGVuY3k6IHtcbiAgICByZXFJZDogeyB0eXBlOiAnU3RyaW5nJyB9LFxuICAgIGV4cGlyZTogeyB0eXBlOiAnRGF0ZScgfSxcbiAgfSxcbn0pO1xuXG4vLyBmaWVsZHMgcmVxdWlyZWQgZm9yIHJlYWQgb3Igd3JpdGUgb3BlcmF0aW9ucyBvbiB0aGVpciByZXNwZWN0aXZlIGNsYXNzZXMuXG5jb25zdCByZXF1aXJlZENvbHVtbnMgPSBPYmplY3QuZnJlZXplKHtcbiAgcmVhZDoge1xuICAgIF9Vc2VyOiBbJ3VzZXJuYW1lJ10sXG4gIH0sXG4gIHdyaXRlOiB7XG4gICAgX1Byb2R1Y3Q6IFsncHJvZHVjdElkZW50aWZpZXInLCAnaWNvbicsICdvcmRlcicsICd0aXRsZScsICdzdWJ0aXRsZSddLFxuICAgIF9Sb2xlOiBbJ25hbWUnLCAnQUNMJ10sXG4gIH0sXG59KTtcblxuY29uc3QgaW52YWxpZENvbHVtbnMgPSBbJ2xlbmd0aCddO1xuXG5jb25zdCBzeXN0ZW1DbGFzc2VzID0gT2JqZWN0LmZyZWV6ZShbXG4gICdfVXNlcicsXG4gICdfSW5zdGFsbGF0aW9uJyxcbiAgJ19Sb2xlJyxcbiAgJ19TZXNzaW9uJyxcbiAgJ19Qcm9kdWN0JyxcbiAgJ19QdXNoU3RhdHVzJyxcbiAgJ19Kb2JTdGF0dXMnLFxuICAnX0pvYlNjaGVkdWxlJyxcbiAgJ19BdWRpZW5jZScsXG4gICdfSWRlbXBvdGVuY3knLFxuXSk7XG5cbmNvbnN0IHZvbGF0aWxlQ2xhc3NlcyA9IE9iamVjdC5mcmVlemUoW1xuICAnX0pvYlN0YXR1cycsXG4gICdfUHVzaFN0YXR1cycsXG4gICdfSG9va3MnLFxuICAnX0dsb2JhbENvbmZpZycsXG4gICdfR3JhcGhRTENvbmZpZycsXG4gICdfSm9iU2NoZWR1bGUnLFxuICAnX0F1ZGllbmNlJyxcbiAgJ19JZGVtcG90ZW5jeScsXG5dKTtcblxuLy8gQW55dGhpbmcgdGhhdCBzdGFydCB3aXRoIHJvbGVcbmNvbnN0IHJvbGVSZWdleCA9IC9ecm9sZTouKi87XG4vLyBBbnl0aGluZyB0aGF0IHN0YXJ0cyB3aXRoIHVzZXJGaWVsZCAoYWxsb3dlZCBmb3IgcHJvdGVjdGVkIGZpZWxkcyBvbmx5KVxuY29uc3QgcHJvdGVjdGVkRmllbGRzUG9pbnRlclJlZ2V4ID0gL151c2VyRmllbGQ6LiovO1xuLy8gKiBwZXJtaXNzaW9uXG5jb25zdCBwdWJsaWNSZWdleCA9IC9eXFwqJC87XG5cbmNvbnN0IGF1dGhlbnRpY2F0ZWRSZWdleCA9IC9eYXV0aGVudGljYXRlZCQvO1xuXG5jb25zdCByZXF1aXJlc0F1dGhlbnRpY2F0aW9uUmVnZXggPSAvXnJlcXVpcmVzQXV0aGVudGljYXRpb24kLztcblxuY29uc3QgY2xwUG9pbnRlclJlZ2V4ID0gL15wb2ludGVyRmllbGRzJC87XG5cbi8vIHJlZ2V4IGZvciB2YWxpZGF0aW5nIGVudGl0aWVzIGluIHByb3RlY3RlZEZpZWxkcyBvYmplY3RcbmNvbnN0IHByb3RlY3RlZEZpZWxkc1JlZ2V4ID0gT2JqZWN0LmZyZWV6ZShbXG4gIHByb3RlY3RlZEZpZWxkc1BvaW50ZXJSZWdleCxcbiAgcHVibGljUmVnZXgsXG4gIGF1dGhlbnRpY2F0ZWRSZWdleCxcbiAgcm9sZVJlZ2V4LFxuXSk7XG5cbi8vIGNscCByZWdleFxuY29uc3QgY2xwRmllbGRzUmVnZXggPSBPYmplY3QuZnJlZXplKFtcbiAgY2xwUG9pbnRlclJlZ2V4LFxuICBwdWJsaWNSZWdleCxcbiAgcmVxdWlyZXNBdXRoZW50aWNhdGlvblJlZ2V4LFxuICByb2xlUmVnZXgsXG5dKTtcblxuZnVuY3Rpb24gdmFsaWRhdGVQZXJtaXNzaW9uS2V5KGtleSwgdXNlcklkUmVnRXhwKSB7XG4gIGxldCBtYXRjaGVzU29tZSA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHJlZ0V4IG9mIGNscEZpZWxkc1JlZ2V4KSB7XG4gICAgaWYgKGtleS5tYXRjaChyZWdFeCkgIT09IG51bGwpIHtcbiAgICAgIG1hdGNoZXNTb21lID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIHVzZXJJZCBkZXBlbmRzIG9uIHN0YXJ0dXAgb3B0aW9ucyBzbyBpdCdzIGR5bmFtaWNcbiAgY29uc3QgdmFsaWQgPSBtYXRjaGVzU29tZSB8fCBrZXkubWF0Y2godXNlcklkUmVnRXhwKSAhPT0gbnVsbDtcbiAgaWYgKCF2YWxpZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgIGAnJHtrZXl9JyBpcyBub3QgYSB2YWxpZCBrZXkgZm9yIGNsYXNzIGxldmVsIHBlcm1pc3Npb25zYFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVQcm90ZWN0ZWRGaWVsZHNLZXkoa2V5LCB1c2VySWRSZWdFeHApIHtcbiAgbGV0IG1hdGNoZXNTb21lID0gZmFsc2U7XG4gIGZvciAoY29uc3QgcmVnRXggb2YgcHJvdGVjdGVkRmllbGRzUmVnZXgpIHtcbiAgICBpZiAoa2V5Lm1hdGNoKHJlZ0V4KSAhPT0gbnVsbCkge1xuICAgICAgbWF0Y2hlc1NvbWUgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgLy8gdXNlcklkIHJlZ2V4IGRlcGVuZHMgb24gbGF1bmNoIG9wdGlvbnMgc28gaXQncyBkeW5hbWljXG4gIGNvbnN0IHZhbGlkID0gbWF0Y2hlc1NvbWUgfHwga2V5Lm1hdGNoKHVzZXJJZFJlZ0V4cCkgIT09IG51bGw7XG4gIGlmICghdmFsaWQpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICBgJyR7a2V5fScgaXMgbm90IGEgdmFsaWQga2V5IGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9uc2BcbiAgICApO1xuICB9XG59XG5cbmNvbnN0IENMUFZhbGlkS2V5cyA9IE9iamVjdC5mcmVlemUoW1xuICAnQUNMJyxcbiAgJ2ZpbmQnLFxuICAnY291bnQnLFxuICAnZ2V0JyxcbiAgJ2NyZWF0ZScsXG4gICd1cGRhdGUnLFxuICAnZGVsZXRlJyxcbiAgJ2FkZEZpZWxkJyxcbiAgJ3JlYWRVc2VyRmllbGRzJyxcbiAgJ3dyaXRlVXNlckZpZWxkcycsXG4gICdwcm90ZWN0ZWRGaWVsZHMnLFxuXSk7XG5cbi8vIHZhbGlkYXRpb24gYmVmb3JlIHNldHRpbmcgY2xhc3MtbGV2ZWwgcGVybWlzc2lvbnMgb24gY29sbGVjdGlvblxuZnVuY3Rpb24gdmFsaWRhdGVDTFAocGVybXM6IENsYXNzTGV2ZWxQZXJtaXNzaW9ucywgZmllbGRzOiBTY2hlbWFGaWVsZHMsIHVzZXJJZFJlZ0V4cDogUmVnRXhwKSB7XG4gIGlmICghcGVybXMpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBvcGVyYXRpb25LZXkgaW4gcGVybXMpIHtcbiAgICBpZiAoQ0xQVmFsaWRLZXlzLmluZGV4T2Yob3BlcmF0aW9uS2V5KSA9PSAtMSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgIGAke29wZXJhdGlvbktleX0gaXMgbm90IGEgdmFsaWQgb3BlcmF0aW9uIGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9uc2BcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3BlcmF0aW9uID0gcGVybXNbb3BlcmF0aW9uS2V5XTtcbiAgICAvLyBwcm9jZWVkIHdpdGggbmV4dCBvcGVyYXRpb25LZXlcblxuICAgIC8vIHRocm93cyB3aGVuIHJvb3QgZmllbGRzIGFyZSBvZiB3cm9uZyB0eXBlXG4gICAgdmFsaWRhdGVDTFBqc29uKG9wZXJhdGlvbiwgb3BlcmF0aW9uS2V5KTtcblxuICAgIGlmIChvcGVyYXRpb25LZXkgPT09ICdyZWFkVXNlckZpZWxkcycgfHwgb3BlcmF0aW9uS2V5ID09PSAnd3JpdGVVc2VyRmllbGRzJykge1xuICAgICAgLy8gdmFsaWRhdGUgZ3JvdXBlZCBwb2ludGVyIHBlcm1pc3Npb25zXG4gICAgICAvLyBtdXN0IGJlIGFuIGFycmF5IHdpdGggZmllbGQgbmFtZXNcbiAgICAgIGZvciAoY29uc3QgZmllbGROYW1lIG9mIG9wZXJhdGlvbikge1xuICAgICAgICB2YWxpZGF0ZVBvaW50ZXJQZXJtaXNzaW9uKGZpZWxkTmFtZSwgZmllbGRzLCBvcGVyYXRpb25LZXkpO1xuICAgICAgfVxuICAgICAgLy8gcmVhZFVzZXJGaWVsZHMgYW5kIHdyaXRlclVzZXJGaWVsZHMgZG8gbm90IGhhdmUgbmVzZHRlZCBmaWVsZHNcbiAgICAgIC8vIHByb2NlZWQgd2l0aCBuZXh0IG9wZXJhdGlvbktleVxuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gdmFsaWRhdGUgcHJvdGVjdGVkIGZpZWxkc1xuICAgIGlmIChvcGVyYXRpb25LZXkgPT09ICdwcm90ZWN0ZWRGaWVsZHMnKSB7XG4gICAgICBmb3IgKGNvbnN0IGVudGl0eSBpbiBvcGVyYXRpb24pIHtcbiAgICAgICAgLy8gdGhyb3dzIG9uIHVuZXhwZWN0ZWQga2V5XG4gICAgICAgIHZhbGlkYXRlUHJvdGVjdGVkRmllbGRzS2V5KGVudGl0eSwgdXNlcklkUmVnRXhwKTtcblxuICAgICAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPSBvcGVyYXRpb25bZW50aXR5XTtcblxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkocHJvdGVjdGVkRmllbGRzKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgIGAnJHtwcm90ZWN0ZWRGaWVsZHN9JyBpcyBub3QgYSB2YWxpZCB2YWx1ZSBmb3IgcHJvdGVjdGVkRmllbGRzWyR7ZW50aXR5fV0gLSBleHBlY3RlZCBhbiBhcnJheS5gXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGlmIHRoZSBmaWVsZCBpcyBpbiBmb3JtIG9mIGFycmF5XG4gICAgICAgIGZvciAoY29uc3QgZmllbGQgb2YgcHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgICAgLy8gZG8gbm90IGFsbG9vdyB0byBwcm90ZWN0IGRlZmF1bHQgZmllbGRzXG4gICAgICAgICAgaWYgKGRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0W2ZpZWxkXSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgIGBEZWZhdWx0IGZpZWxkICcke2ZpZWxkfScgY2FuIG5vdCBiZSBwcm90ZWN0ZWRgXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBmaWVsZCBzaG91bGQgZXhpc3Qgb24gY29sbGVjdGlvblxuICAgICAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGZpZWxkcywgZmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgYEZpZWxkICcke2ZpZWxkfScgaW4gcHJvdGVjdGVkRmllbGRzOiR7ZW50aXR5fSBkb2VzIG5vdCBleGlzdGBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBwcm9jZWVkIHdpdGggbmV4dCBvcGVyYXRpb25LZXlcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIHZhbGlkYXRlIG90aGVyIGZpZWxkc1xuICAgIC8vIEVudGl0eSBjYW4gYmU6XG4gICAgLy8gXCIqXCIgLSBQdWJsaWMsXG4gICAgLy8gXCJyZXF1aXJlc0F1dGhlbnRpY2F0aW9uXCIgLSBhdXRoZW50aWNhdGVkIHVzZXJzLFxuICAgIC8vIFwib2JqZWN0SWRcIiAtIF9Vc2VyIGlkLFxuICAgIC8vIFwicm9sZTpyb2xlbmFtZVwiLFxuICAgIC8vIFwicG9pbnRlckZpZWxkc1wiIC0gYXJyYXkgb2YgZmllbGQgbmFtZXMgY29udGFpbmluZyBwb2ludGVycyB0byB1c2Vyc1xuICAgIGZvciAoY29uc3QgZW50aXR5IGluIG9wZXJhdGlvbikge1xuICAgICAgLy8gdGhyb3dzIG9uIHVuZXhwZWN0ZWQga2V5XG4gICAgICB2YWxpZGF0ZVBlcm1pc3Npb25LZXkoZW50aXR5LCB1c2VySWRSZWdFeHApO1xuXG4gICAgICAvLyBlbnRpdHkgY2FuIGJlIGVpdGhlcjpcbiAgICAgIC8vIFwicG9pbnRlckZpZWxkc1wiOiBzdHJpbmdbXVxuICAgICAgaWYgKGVudGl0eSA9PT0gJ3BvaW50ZXJGaWVsZHMnKSB7XG4gICAgICAgIGNvbnN0IHBvaW50ZXJGaWVsZHMgPSBvcGVyYXRpb25bZW50aXR5XTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShwb2ludGVyRmllbGRzKSkge1xuICAgICAgICAgIGZvciAoY29uc3QgcG9pbnRlckZpZWxkIG9mIHBvaW50ZXJGaWVsZHMpIHtcbiAgICAgICAgICAgIHZhbGlkYXRlUG9pbnRlclBlcm1pc3Npb24ocG9pbnRlckZpZWxkLCBmaWVsZHMsIG9wZXJhdGlvbik7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgIGAnJHtwb2ludGVyRmllbGRzfScgaXMgbm90IGEgdmFsaWQgdmFsdWUgZm9yICR7b3BlcmF0aW9uS2V5fVske2VudGl0eX1dIC0gZXhwZWN0ZWQgYW4gYXJyYXkuYFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gcHJvY2VlZCB3aXRoIG5leHQgZW50aXR5IGtleVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcGVybWl0ID0gb3BlcmF0aW9uW2VudGl0eV07XG5cbiAgICAgIGlmIChvcGVyYXRpb25LZXkgPT09ICdBQ0wnKSB7XG4gICAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwocGVybWl0KSAhPT0gJ1tvYmplY3QgT2JqZWN0XScpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICBgJyR7cGVybWl0fScgaXMgbm90IGEgdmFsaWQgdmFsdWUgZm9yIGNsYXNzIGxldmVsIHBlcm1pc3Npb25zIGFjbGBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGludmFsaWRLZXlzID0gT2JqZWN0LmtleXMocGVybWl0KS5maWx0ZXIoa2V5ID0+ICFbJ3JlYWQnLCAnd3JpdGUnXS5pbmNsdWRlcyhrZXkpKTtcbiAgICAgICAgY29uc3QgaW52YWxpZFZhbHVlcyA9IE9iamVjdC52YWx1ZXMocGVybWl0KS5maWx0ZXIoa2V5ID0+IHR5cGVvZiBrZXkgIT09ICdib29sZWFuJyk7XG4gICAgICAgIGlmIChpbnZhbGlkS2V5cy5sZW5ndGgpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICBgJyR7aW52YWxpZEtleXMuam9pbignLCcpfScgaXMgbm90IGEgdmFsaWQga2V5IGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9ucyBhY2xgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbnZhbGlkVmFsdWVzLmxlbmd0aCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgIGAnJHtpbnZhbGlkVmFsdWVzLmpvaW4oJywnKX0nIGlzIG5vdCBhIHZhbGlkIHZhbHVlIGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9ucyBhY2xgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChwZXJtaXQgIT09IHRydWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgJyR7cGVybWl0fScgaXMgbm90IGEgdmFsaWQgdmFsdWUgZm9yIGNsYXNzIGxldmVsIHBlcm1pc3Npb25zIGFjbCAke29wZXJhdGlvbktleX06JHtlbnRpdHl9YFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUNMUGpzb24ob3BlcmF0aW9uOiBhbnksIG9wZXJhdGlvbktleTogc3RyaW5nKSB7XG4gIGlmIChvcGVyYXRpb25LZXkgPT09ICdyZWFkVXNlckZpZWxkcycgfHwgb3BlcmF0aW9uS2V5ID09PSAnd3JpdGVVc2VyRmllbGRzJykge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShvcGVyYXRpb24pKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgYCcke29wZXJhdGlvbn0nIGlzIG5vdCBhIHZhbGlkIHZhbHVlIGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9ucyAke29wZXJhdGlvbktleX0gLSBtdXN0IGJlIGFuIGFycmF5YFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKHR5cGVvZiBvcGVyYXRpb24gPT09ICdvYmplY3QnICYmIG9wZXJhdGlvbiAhPT0gbnVsbCkge1xuICAgICAgLy8gb2sgdG8gcHJvY2VlZFxuICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgYCcke29wZXJhdGlvbn0nIGlzIG5vdCBhIHZhbGlkIHZhbHVlIGZvciBjbGFzcyBsZXZlbCBwZXJtaXNzaW9ucyAke29wZXJhdGlvbktleX0gLSBtdXN0IGJlIGFuIG9iamVjdGBcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUG9pbnRlclBlcm1pc3Npb24oZmllbGROYW1lOiBzdHJpbmcsIGZpZWxkczogT2JqZWN0LCBvcGVyYXRpb246IHN0cmluZykge1xuICAvLyBVc2VzIGNvbGxlY3Rpb24gc2NoZW1hIHRvIGVuc3VyZSB0aGUgZmllbGQgaXMgb2YgdHlwZTpcbiAgLy8gLSBQb2ludGVyPF9Vc2VyPiAocG9pbnRlcnMpXG4gIC8vIC0gQXJyYXlcbiAgLy9cbiAgLy8gICAgSXQncyBub3QgcG9zc2libGUgdG8gZW5mb3JjZSB0eXBlIG9uIEFycmF5J3MgaXRlbXMgaW4gc2NoZW1hXG4gIC8vICBzbyB3ZSBhY2NlcHQgYW55IEFycmF5IGZpZWxkLCBhbmQgbGF0ZXIgd2hlbiBhcHBseWluZyBwZXJtaXNzaW9uc1xuICAvLyAgb25seSBpdGVtcyB0aGF0IGFyZSBwb2ludGVycyB0byBfVXNlciBhcmUgY29uc2lkZXJlZC5cbiAgaWYgKFxuICAgICEoXG4gICAgICBmaWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgKChmaWVsZHNbZmllbGROYW1lXS50eXBlID09ICdQb2ludGVyJyAmJiBmaWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyA9PSAnX1VzZXInKSB8fFxuICAgICAgICBmaWVsZHNbZmllbGROYW1lXS50eXBlID09ICdBcnJheScpXG4gICAgKVxuICApIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICBgJyR7ZmllbGROYW1lfScgaXMgbm90IGEgdmFsaWQgY29sdW1uIGZvciBjbGFzcyBsZXZlbCBwb2ludGVyIHBlcm1pc3Npb25zICR7b3BlcmF0aW9ufWBcbiAgICApO1xuICB9XG59XG5cbmNvbnN0IGpvaW5DbGFzc1JlZ2V4ID0gL15fSm9pbjpbQS1aYS16MC05X10rOltBLVphLXowLTlfXSsvO1xuY29uc3QgY2xhc3NBbmRGaWVsZFJlZ2V4ID0gL15bQS1aYS16XVtBLVphLXowLTlfXSokLztcbmZ1bmN0aW9uIGNsYXNzTmFtZUlzVmFsaWQoY2xhc3NOYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gVmFsaWQgY2xhc3NlcyBtdXN0OlxuICByZXR1cm4gKFxuICAgIC8vIEJlIG9uZSBvZiBfVXNlciwgX0luc3RhbGxhdGlvbiwgX1JvbGUsIF9TZXNzaW9uIE9SXG4gICAgc3lzdGVtQ2xhc3Nlcy5pbmRleE9mKGNsYXNzTmFtZSkgPiAtMSB8fFxuICAgIC8vIEJlIGEgam9pbiB0YWJsZSBPUlxuICAgIGpvaW5DbGFzc1JlZ2V4LnRlc3QoY2xhc3NOYW1lKSB8fFxuICAgIC8vIEluY2x1ZGUgb25seSBhbHBoYS1udW1lcmljIGFuZCB1bmRlcnNjb3JlcywgYW5kIG5vdCBzdGFydCB3aXRoIGFuIHVuZGVyc2NvcmUgb3IgbnVtYmVyXG4gICAgZmllbGROYW1lSXNWYWxpZChjbGFzc05hbWUsIGNsYXNzTmFtZSlcbiAgKTtcbn1cblxuLy8gVmFsaWQgZmllbGRzIG11c3QgYmUgYWxwaGEtbnVtZXJpYywgYW5kIG5vdCBzdGFydCB3aXRoIGFuIHVuZGVyc2NvcmUgb3IgbnVtYmVyXG4vLyBtdXN0IG5vdCBiZSBhIHJlc2VydmVkIGtleVxuZnVuY3Rpb24gZmllbGROYW1lSXNWYWxpZChmaWVsZE5hbWU6IHN0cmluZywgY2xhc3NOYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGNsYXNzTmFtZSAmJiBjbGFzc05hbWUgIT09ICdfSG9va3MnKSB7XG4gICAgaWYgKGZpZWxkTmFtZSA9PT0gJ2NsYXNzTmFtZScpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNsYXNzQW5kRmllbGRSZWdleC50ZXN0KGZpZWxkTmFtZSkgJiYgIWludmFsaWRDb2x1bW5zLmluY2x1ZGVzKGZpZWxkTmFtZSk7XG59XG5cbi8vIENoZWNrcyB0aGF0IGl0J3Mgbm90IHRyeWluZyB0byBjbG9iYmVyIG9uZSBvZiB0aGUgZGVmYXVsdCBmaWVsZHMgb2YgdGhlIGNsYXNzLlxuZnVuY3Rpb24gZmllbGROYW1lSXNWYWxpZEZvckNsYXNzKGZpZWxkTmFtZTogc3RyaW5nLCBjbGFzc05hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWZpZWxkTmFtZUlzVmFsaWQoZmllbGROYW1lLCBjbGFzc05hbWUpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChkZWZhdWx0Q29sdW1ucy5fRGVmYXVsdFtmaWVsZE5hbWVdKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChkZWZhdWx0Q29sdW1uc1tjbGFzc05hbWVdICYmIGRlZmF1bHRDb2x1bW5zW2NsYXNzTmFtZV1bZmllbGROYW1lXSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gaW52YWxpZENsYXNzTmFtZU1lc3NhZ2UoY2xhc3NOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgICdJbnZhbGlkIGNsYXNzbmFtZTogJyArXG4gICAgY2xhc3NOYW1lICtcbiAgICAnLCBjbGFzc25hbWVzIGNhbiBvbmx5IGhhdmUgYWxwaGFudW1lcmljIGNoYXJhY3RlcnMgYW5kIF8sIGFuZCBtdXN0IHN0YXJ0IHdpdGggYW4gYWxwaGEgY2hhcmFjdGVyICdcbiAgKTtcbn1cblxuY29uc3QgaW52YWxpZEpzb25FcnJvciA9IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdpbnZhbGlkIEpTT04nKTtcbmNvbnN0IHZhbGlkTm9uUmVsYXRpb25PclBvaW50ZXJUeXBlcyA9IFtcbiAgJ051bWJlcicsXG4gICdTdHJpbmcnLFxuICAnQm9vbGVhbicsXG4gICdEYXRlJyxcbiAgJ09iamVjdCcsXG4gICdBcnJheScsXG4gICdHZW9Qb2ludCcsXG4gICdGaWxlJyxcbiAgJ0J5dGVzJyxcbiAgJ1BvbHlnb24nLFxuXTtcbi8vIFJldHVybnMgYW4gZXJyb3Igc3VpdGFibGUgZm9yIHRocm93aW5nIGlmIHRoZSB0eXBlIGlzIGludmFsaWRcbmNvbnN0IGZpZWxkVHlwZUlzSW52YWxpZCA9ICh7IHR5cGUsIHRhcmdldENsYXNzIH0pID0+IHtcbiAgaWYgKFsnUG9pbnRlcicsICdSZWxhdGlvbiddLmluZGV4T2YodHlwZSkgPj0gMCkge1xuICAgIGlmICghdGFyZ2V0Q2xhc3MpIHtcbiAgICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoMTM1LCBgdHlwZSAke3R5cGV9IG5lZWRzIGEgY2xhc3MgbmFtZWApO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHRhcmdldENsYXNzICE9PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGludmFsaWRKc29uRXJyb3I7XG4gICAgfSBlbHNlIGlmICghY2xhc3NOYW1lSXNWYWxpZCh0YXJnZXRDbGFzcykpIHtcbiAgICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9DTEFTU19OQU1FLCBpbnZhbGlkQ2xhc3NOYW1lTWVzc2FnZSh0YXJnZXRDbGFzcykpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuICBpZiAodHlwZW9mIHR5cGUgIT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIGludmFsaWRKc29uRXJyb3I7XG4gIH1cbiAgaWYgKHZhbGlkTm9uUmVsYXRpb25PclBvaW50ZXJUeXBlcy5pbmRleE9mKHR5cGUpIDwgMCkge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5DT1JSRUNUX1RZUEUsIGBpbnZhbGlkIGZpZWxkIHR5cGU6ICR7dHlwZX1gKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufTtcblxuY29uc3QgY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYSA9IChzY2hlbWE6IGFueSkgPT4ge1xuICBzY2hlbWEgPSBpbmplY3REZWZhdWx0U2NoZW1hKHNjaGVtYSk7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLkFDTDtcbiAgc2NoZW1hLmZpZWxkcy5fcnBlcm0gPSB7IHR5cGU6ICdBcnJheScgfTtcbiAgc2NoZW1hLmZpZWxkcy5fd3Blcm0gPSB7IHR5cGU6ICdBcnJheScgfTtcblxuICBpZiAoc2NoZW1hLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLnBhc3N3b3JkO1xuICAgIHNjaGVtYS5maWVsZHMuX2hhc2hlZF9wYXNzd29yZCA9IHsgdHlwZTogJ1N0cmluZycgfTtcbiAgfVxuXG4gIHJldHVybiBzY2hlbWE7XG59O1xuXG5jb25zdCBjb252ZXJ0QWRhcHRlclNjaGVtYVRvUGFyc2VTY2hlbWEgPSAoeyAuLi5zY2hlbWEgfSkgPT4ge1xuICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fcnBlcm07XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl93cGVybTtcblxuICBzY2hlbWEuZmllbGRzLkFDTCA9IHsgdHlwZTogJ0FDTCcgfTtcblxuICBpZiAoc2NoZW1hLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLmF1dGhEYXRhOyAvL0F1dGggZGF0YSBpcyBpbXBsaWNpdFxuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9oYXNoZWRfcGFzc3dvcmQ7XG4gICAgc2NoZW1hLmZpZWxkcy5wYXNzd29yZCA9IHsgdHlwZTogJ1N0cmluZycgfTtcbiAgfVxuXG4gIGlmIChzY2hlbWEuaW5kZXhlcyAmJiBPYmplY3Qua2V5cyhzY2hlbWEuaW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgZGVsZXRlIHNjaGVtYS5pbmRleGVzO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbmNsYXNzIFNjaGVtYURhdGEge1xuICBfX2RhdGE6IGFueTtcbiAgX19wcm90ZWN0ZWRGaWVsZHM6IGFueTtcbiAgY29uc3RydWN0b3IoYWxsU2NoZW1hcyA9IFtdLCBwcm90ZWN0ZWRGaWVsZHMgPSB7fSkge1xuICAgIHRoaXMuX19kYXRhID0ge307XG4gICAgdGhpcy5fX3Byb3RlY3RlZEZpZWxkcyA9IHByb3RlY3RlZEZpZWxkcztcbiAgICBhbGxTY2hlbWFzLmZvckVhY2goc2NoZW1hID0+IHtcbiAgICAgIGlmICh2b2xhdGlsZUNsYXNzZXMuaW5jbHVkZXMoc2NoZW1hLmNsYXNzTmFtZSkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHRoaXMsIHNjaGVtYS5jbGFzc05hbWUsIHtcbiAgICAgICAgZ2V0OiAoKSA9PiB7XG4gICAgICAgICAgaWYgKCF0aGlzLl9fZGF0YVtzY2hlbWEuY2xhc3NOYW1lXSkge1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IHt9O1xuICAgICAgICAgICAgZGF0YS5maWVsZHMgPSBpbmplY3REZWZhdWx0U2NoZW1hKHNjaGVtYSkuZmllbGRzO1xuICAgICAgICAgICAgZGF0YS5jbGFzc0xldmVsUGVybWlzc2lvbnMgPSBzdHJ1Y3R1cmVkQ2xvbmUoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucyk7XG4gICAgICAgICAgICBkYXRhLmluZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcblxuICAgICAgICAgICAgY29uc3QgY2xhc3NQcm90ZWN0ZWRGaWVsZHMgPSB0aGlzLl9fcHJvdGVjdGVkRmllbGRzW3NjaGVtYS5jbGFzc05hbWVdO1xuICAgICAgICAgICAgaWYgKGNsYXNzUHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IGluIGNsYXNzUHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdW5xID0gbmV3IFNldChbXG4gICAgICAgICAgICAgICAgICAuLi4oZGF0YS5jbGFzc0xldmVsUGVybWlzc2lvbnMucHJvdGVjdGVkRmllbGRzW2tleV0gfHwgW10pLFxuICAgICAgICAgICAgICAgICAgLi4uY2xhc3NQcm90ZWN0ZWRGaWVsZHNba2V5XSxcbiAgICAgICAgICAgICAgICBdKTtcbiAgICAgICAgICAgICAgICBkYXRhLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucy5wcm90ZWN0ZWRGaWVsZHNba2V5XSA9IEFycmF5LmZyb20odW5xKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9fZGF0YVtzY2hlbWEuY2xhc3NOYW1lXSA9IGRhdGE7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aGlzLl9fZGF0YVtzY2hlbWEuY2xhc3NOYW1lXTtcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgLy8gSW5qZWN0IHRoZSBpbi1tZW1vcnkgY2xhc3Nlc1xuICAgIHZvbGF0aWxlQ2xhc3Nlcy5mb3JFYWNoKGNsYXNzTmFtZSA9PiB7XG4gICAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgY2xhc3NOYW1lLCB7XG4gICAgICAgIGdldDogKCkgPT4ge1xuICAgICAgICAgIGlmICghdGhpcy5fX2RhdGFbY2xhc3NOYW1lXSkge1xuICAgICAgICAgICAgY29uc3Qgc2NoZW1hID0gaW5qZWN0RGVmYXVsdFNjaGVtYSh7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgZmllbGRzOiB7fSxcbiAgICAgICAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiB7fSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IHt9O1xuICAgICAgICAgICAgZGF0YS5maWVsZHMgPSBzY2hlbWEuZmllbGRzO1xuICAgICAgICAgICAgZGF0YS5jbGFzc0xldmVsUGVybWlzc2lvbnMgPSBzY2hlbWEuY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgICAgICAgICAgZGF0YS5pbmRleGVzID0gc2NoZW1hLmluZGV4ZXM7XG4gICAgICAgICAgICB0aGlzLl9fZGF0YVtjbGFzc05hbWVdID0gZGF0YTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRoaXMuX19kYXRhW2NsYXNzTmFtZV07XG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxufVxuXG5jb25zdCBpbmplY3REZWZhdWx0U2NoZW1hID0gKHsgY2xhc3NOYW1lLCBmaWVsZHMsIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucywgaW5kZXhlcyB9OiBTY2hlbWEpID0+IHtcbiAgY29uc3QgZGVmYXVsdFNjaGVtYTogU2NoZW1hID0ge1xuICAgIGNsYXNzTmFtZSxcbiAgICBmaWVsZHM6IHtcbiAgICAgIC4uLmRlZmF1bHRDb2x1bW5zLl9EZWZhdWx0LFxuICAgICAgLi4uKGRlZmF1bHRDb2x1bW5zW2NsYXNzTmFtZV0gfHwge30pLFxuICAgICAgLi4uZmllbGRzLFxuICAgIH0sXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICB9O1xuICBpZiAoaW5kZXhlcyAmJiBPYmplY3Qua2V5cyhpbmRleGVzKS5sZW5ndGggIT09IDApIHtcbiAgICBkZWZhdWx0U2NoZW1hLmluZGV4ZXMgPSBpbmRleGVzO1xuICB9XG4gIHJldHVybiBkZWZhdWx0U2NoZW1hO1xufTtcblxuY29uc3QgX0hvb2tzU2NoZW1hID0geyBjbGFzc05hbWU6ICdfSG9va3MnLCBmaWVsZHM6IGRlZmF1bHRDb2x1bW5zLl9Ib29rcyB9O1xuY29uc3QgX0dsb2JhbENvbmZpZ1NjaGVtYSA9IHtcbiAgY2xhc3NOYW1lOiAnX0dsb2JhbENvbmZpZycsXG4gIGZpZWxkczogZGVmYXVsdENvbHVtbnMuX0dsb2JhbENvbmZpZyxcbn07XG5jb25zdCBfR3JhcGhRTENvbmZpZ1NjaGVtYSA9IHtcbiAgY2xhc3NOYW1lOiAnX0dyYXBoUUxDb25maWcnLFxuICBmaWVsZHM6IGRlZmF1bHRDb2x1bW5zLl9HcmFwaFFMQ29uZmlnLFxufTtcbmNvbnN0IF9QdXNoU3RhdHVzU2NoZW1hID0gY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYShcbiAgaW5qZWN0RGVmYXVsdFNjaGVtYSh7XG4gICAgY2xhc3NOYW1lOiAnX1B1c2hTdGF0dXMnLFxuICAgIGZpZWxkczoge30sXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiB7fSxcbiAgfSlcbik7XG5jb25zdCBfSm9iU3RhdHVzU2NoZW1hID0gY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYShcbiAgaW5qZWN0RGVmYXVsdFNjaGVtYSh7XG4gICAgY2xhc3NOYW1lOiAnX0pvYlN0YXR1cycsXG4gICAgZmllbGRzOiB7fSxcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6IHt9LFxuICB9KVxuKTtcbmNvbnN0IF9Kb2JTY2hlZHVsZVNjaGVtYSA9IGNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEoXG4gIGluamVjdERlZmF1bHRTY2hlbWEoe1xuICAgIGNsYXNzTmFtZTogJ19Kb2JTY2hlZHVsZScsXG4gICAgZmllbGRzOiB7fSxcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6IHt9LFxuICB9KVxuKTtcbmNvbnN0IF9BdWRpZW5jZVNjaGVtYSA9IGNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEoXG4gIGluamVjdERlZmF1bHRTY2hlbWEoe1xuICAgIGNsYXNzTmFtZTogJ19BdWRpZW5jZScsXG4gICAgZmllbGRzOiBkZWZhdWx0Q29sdW1ucy5fQXVkaWVuY2UsXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiB7fSxcbiAgfSlcbik7XG5jb25zdCBfSWRlbXBvdGVuY3lTY2hlbWEgPSBjb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hKFxuICBpbmplY3REZWZhdWx0U2NoZW1hKHtcbiAgICBjbGFzc05hbWU6ICdfSWRlbXBvdGVuY3knLFxuICAgIGZpZWxkczogZGVmYXVsdENvbHVtbnMuX0lkZW1wb3RlbmN5LFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9uczoge30sXG4gIH0pXG4pO1xuY29uc3QgVm9sYXRpbGVDbGFzc2VzU2NoZW1hcyA9IFtcbiAgX0hvb2tzU2NoZW1hLFxuICBfSm9iU3RhdHVzU2NoZW1hLFxuICBfSm9iU2NoZWR1bGVTY2hlbWEsXG4gIF9QdXNoU3RhdHVzU2NoZW1hLFxuICBfR2xvYmFsQ29uZmlnU2NoZW1hLFxuICBfR3JhcGhRTENvbmZpZ1NjaGVtYSxcbiAgX0F1ZGllbmNlU2NoZW1hLFxuICBfSWRlbXBvdGVuY3lTY2hlbWEsXG5dO1xuXG5jb25zdCBkYlR5cGVNYXRjaGVzT2JqZWN0VHlwZSA9IChkYlR5cGU6IFNjaGVtYUZpZWxkIHwgc3RyaW5nLCBvYmplY3RUeXBlOiBTY2hlbWFGaWVsZCkgPT4ge1xuICBpZiAoZGJUeXBlLnR5cGUgIT09IG9iamVjdFR5cGUudHlwZSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgaWYgKGRiVHlwZS50YXJnZXRDbGFzcyAhPT0gb2JqZWN0VHlwZS50YXJnZXRDbGFzcykgeyByZXR1cm4gZmFsc2U7IH1cbiAgaWYgKGRiVHlwZSA9PT0gb2JqZWN0VHlwZS50eXBlKSB7IHJldHVybiB0cnVlOyB9XG4gIGlmIChkYlR5cGUudHlwZSA9PT0gb2JqZWN0VHlwZS50eXBlKSB7IHJldHVybiB0cnVlOyB9XG4gIHJldHVybiBmYWxzZTtcbn07XG5cbmNvbnN0IHR5cGVUb1N0cmluZyA9ICh0eXBlOiBTY2hlbWFGaWVsZCB8IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gIGlmICh0eXBlb2YgdHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gdHlwZTtcbiAgfVxuICBpZiAodHlwZS50YXJnZXRDbGFzcykge1xuICAgIHJldHVybiBgJHt0eXBlLnR5cGV9PCR7dHlwZS50YXJnZXRDbGFzc30+YDtcbiAgfVxuICByZXR1cm4gYCR7dHlwZS50eXBlfWA7XG59O1xuY29uc3QgdHRsID0ge1xuICBkYXRlOiBEYXRlLm5vdygpLFxuICBkdXJhdGlvbjogdW5kZWZpbmVkLFxufTtcblxuLy8gU3RvcmVzIHRoZSBlbnRpcmUgc2NoZW1hIG9mIHRoZSBhcHAgaW4gYSB3ZWlyZCBoeWJyaWQgZm9ybWF0IHNvbWV3aGVyZSBiZXR3ZWVuXG4vLyB0aGUgbW9uZ28gZm9ybWF0IGFuZCB0aGUgUGFyc2UgZm9ybWF0LiBTb29uLCB0aGlzIHdpbGwgYWxsIGJlIFBhcnNlIGZvcm1hdC5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFNjaGVtYUNvbnRyb2xsZXIge1xuICBfZGJBZGFwdGVyOiBTdG9yYWdlQWRhcHRlcjtcbiAgc2NoZW1hRGF0YTogeyBbc3RyaW5nXTogU2NoZW1hIH07XG4gIHJlbG9hZERhdGFQcm9taXNlOiA/UHJvbWlzZTxhbnk+O1xuICBwcm90ZWN0ZWRGaWVsZHM6IGFueTtcbiAgdXNlcklkUmVnRXg6IFJlZ0V4cDtcblxuICBjb25zdHJ1Y3RvcihkYXRhYmFzZUFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyKSB7XG4gICAgdGhpcy5fZGJBZGFwdGVyID0gZGF0YWJhc2VBZGFwdGVyO1xuICAgIGNvbnN0IGNvbmZpZyA9IENvbmZpZy5nZXQoUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gICAgdGhpcy5zY2hlbWFEYXRhID0gbmV3IFNjaGVtYURhdGEoU2NoZW1hQ2FjaGUuYWxsKCksIHRoaXMucHJvdGVjdGVkRmllbGRzKTtcbiAgICB0aGlzLnByb3RlY3RlZEZpZWxkcyA9IGNvbmZpZy5wcm90ZWN0ZWRGaWVsZHM7XG5cbiAgICBjb25zdCBjdXN0b21JZHMgPSBjb25maWcuYWxsb3dDdXN0b21PYmplY3RJZDtcblxuICAgIGNvbnN0IGN1c3RvbUlkUmVnRXggPSAvXi57MSx9JC91OyAvLyAxKyBjaGFyc1xuICAgIGNvbnN0IGF1dG9JZFJlZ0V4ID0gL15bYS16QS1aMC05XXsxLH0kLztcblxuICAgIHRoaXMudXNlcklkUmVnRXggPSBjdXN0b21JZHMgPyBjdXN0b21JZFJlZ0V4IDogYXV0b0lkUmVnRXg7XG5cbiAgICB0aGlzLl9kYkFkYXB0ZXIud2F0Y2goKCkgPT4ge1xuICAgICAgdGhpcy5yZWxvYWREYXRhKHsgY2xlYXJDYWNoZTogdHJ1ZSB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIHJlbG9hZERhdGFJZk5lZWRlZCgpIHtcbiAgICBpZiAodGhpcy5fZGJBZGFwdGVyLmVuYWJsZVNjaGVtYUhvb2tzKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHsgZGF0ZSwgZHVyYXRpb24gfSA9IHR0bCB8fCB7fTtcbiAgICBpZiAoIWR1cmF0aW9uKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgaWYgKG5vdyAtIGRhdGUgPiBkdXJhdGlvbikge1xuICAgICAgdHRsLmRhdGUgPSBub3c7XG4gICAgICBhd2FpdCB0aGlzLnJlbG9hZERhdGEoeyBjbGVhckNhY2hlOiB0cnVlIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJlbG9hZERhdGEob3B0aW9uczogTG9hZFNjaGVtYU9wdGlvbnMgPSB7IGNsZWFyQ2FjaGU6IGZhbHNlIH0pOiBQcm9taXNlPGFueT4ge1xuICAgIGlmICh0aGlzLnJlbG9hZERhdGFQcm9taXNlICYmICFvcHRpb25zLmNsZWFyQ2FjaGUpIHtcbiAgICAgIHJldHVybiB0aGlzLnJlbG9hZERhdGFQcm9taXNlO1xuICAgIH1cbiAgICB0aGlzLnJlbG9hZERhdGFQcm9taXNlID0gdGhpcy5nZXRBbGxDbGFzc2VzKG9wdGlvbnMpXG4gICAgICAudGhlbihcbiAgICAgICAgYWxsU2NoZW1hcyA9PiB7XG4gICAgICAgICAgdGhpcy5zY2hlbWFEYXRhID0gbmV3IFNjaGVtYURhdGEoYWxsU2NoZW1hcywgdGhpcy5wcm90ZWN0ZWRGaWVsZHMpO1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLnJlbG9hZERhdGFQcm9taXNlO1xuICAgICAgICB9LFxuICAgICAgICBlcnIgPT4ge1xuICAgICAgICAgIHRoaXMuc2NoZW1hRGF0YSA9IG5ldyBTY2hlbWFEYXRhKCk7XG4gICAgICAgICAgZGVsZXRlIHRoaXMucmVsb2FkRGF0YVByb21pc2U7XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICApXG4gICAgICAudGhlbigoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHRoaXMucmVsb2FkRGF0YVByb21pc2U7XG4gIH1cblxuICBhc3luYyBnZXRBbGxDbGFzc2VzKG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9KTogUHJvbWlzZTxBcnJheTxTY2hlbWE+PiB7XG4gICAgaWYgKG9wdGlvbnMuY2xlYXJDYWNoZSkge1xuICAgICAgcmV0dXJuIHRoaXMuc2V0QWxsQ2xhc3NlcygpO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLnJlbG9hZERhdGFJZk5lZWRlZCgpO1xuICAgIGNvbnN0IGNhY2hlZCA9IFNjaGVtYUNhY2hlLmFsbCgpO1xuICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShjYWNoZWQpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5zZXRBbGxDbGFzc2VzKCk7XG4gIH1cblxuICBzZXRBbGxDbGFzc2VzKCk6IFByb21pc2U8QXJyYXk8U2NoZW1hPj4ge1xuICAgIHJldHVybiB0aGlzLl9kYkFkYXB0ZXJcbiAgICAgIC5nZXRBbGxDbGFzc2VzKClcbiAgICAgIC50aGVuKGFsbFNjaGVtYXMgPT4gYWxsU2NoZW1hcy5tYXAoaW5qZWN0RGVmYXVsdFNjaGVtYSkpXG4gICAgICAudGhlbihhbGxTY2hlbWFzID0+IHtcbiAgICAgICAgU2NoZW1hQ2FjaGUucHV0KGFsbFNjaGVtYXMpO1xuICAgICAgICByZXR1cm4gYWxsU2NoZW1hcztcbiAgICAgIH0pO1xuICB9XG5cbiAgZ2V0T25lU2NoZW1hKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGFsbG93Vm9sYXRpbGVDbGFzc2VzOiBib29sZWFuID0gZmFsc2UsXG4gICAgb3B0aW9uczogTG9hZFNjaGVtYU9wdGlvbnMgPSB7IGNsZWFyQ2FjaGU6IGZhbHNlIH1cbiAgKTogUHJvbWlzZTxTY2hlbWE+IHtcbiAgICBpZiAob3B0aW9ucy5jbGVhckNhY2hlKSB7XG4gICAgICBTY2hlbWFDYWNoZS5jbGVhcigpO1xuICAgIH1cbiAgICBpZiAoYWxsb3dWb2xhdGlsZUNsYXNzZXMgJiYgdm9sYXRpbGVDbGFzc2VzLmluZGV4T2YoY2xhc3NOYW1lKSA+IC0xKSB7XG4gICAgICBjb25zdCBkYXRhID0gdGhpcy5zY2hlbWFEYXRhW2NsYXNzTmFtZV07XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHtcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICBmaWVsZHM6IGRhdGEuZmllbGRzLFxuICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6IGRhdGEuY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICBpbmRleGVzOiBkYXRhLmluZGV4ZXMsXG4gICAgICB9KTtcbiAgICB9XG4gICAgY29uc3QgY2FjaGVkID0gU2NoZW1hQ2FjaGUuZ2V0KGNsYXNzTmFtZSk7XG4gICAgaWYgKGNhY2hlZCAmJiAhb3B0aW9ucy5jbGVhckNhY2hlKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGNhY2hlZCk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnNldEFsbENsYXNzZXMoKS50aGVuKGFsbFNjaGVtYXMgPT4ge1xuICAgICAgY29uc3Qgb25lU2NoZW1hID0gYWxsU2NoZW1hcy5maW5kKHNjaGVtYSA9PiBzY2hlbWEuY2xhc3NOYW1lID09PSBjbGFzc05hbWUpO1xuICAgICAgaWYgKCFvbmVTY2hlbWEpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KHVuZGVmaW5lZCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gb25lU2NoZW1hO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gQ3JlYXRlIGEgbmV3IGNsYXNzIHRoYXQgaW5jbHVkZXMgdGhlIHRocmVlIGRlZmF1bHQgZmllbGRzLlxuICAvLyBBQ0wgaXMgYW4gaW1wbGljaXQgY29sdW1uIHRoYXQgZG9lcyBub3QgZ2V0IGFuIGVudHJ5IGluIHRoZVxuICAvLyBfU0NIRU1BUyBkYXRhYmFzZS4gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aXRoIHRoZVxuICAvLyBjcmVhdGVkIHNjaGVtYSwgaW4gbW9uZ28gZm9ybWF0LlxuICAvLyBvbiBzdWNjZXNzLCBhbmQgcmVqZWN0cyB3aXRoIGFuIGVycm9yIG9uIGZhaWwuIEVuc3VyZSB5b3VcbiAgLy8gaGF2ZSBhdXRob3JpemF0aW9uIChtYXN0ZXIga2V5LCBvciBjbGllbnQgY2xhc3MgY3JlYXRpb25cbiAgLy8gZW5hYmxlZCkgYmVmb3JlIGNhbGxpbmcgdGhpcyBmdW5jdGlvbi5cbiAgYXN5bmMgYWRkQ2xhc3NJZk5vdEV4aXN0cyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBmaWVsZHM6IFNjaGVtYUZpZWxkcyA9IHt9LFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9uczogYW55LFxuICAgIGluZGV4ZXM6IGFueSA9IHt9XG4gICk6IFByb21pc2U8dm9pZCB8IFNjaGVtYT4ge1xuICAgIHZhciB2YWxpZGF0aW9uRXJyb3IgPSB0aGlzLnZhbGlkYXRlTmV3Q2xhc3MoY2xhc3NOYW1lLCBmaWVsZHMsIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyk7XG4gICAgaWYgKHZhbGlkYXRpb25FcnJvcikge1xuICAgICAgaWYgKHZhbGlkYXRpb25FcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdCh2YWxpZGF0aW9uRXJyb3IpO1xuICAgICAgfSBlbHNlIGlmICh2YWxpZGF0aW9uRXJyb3IuY29kZSAmJiB2YWxpZGF0aW9uRXJyb3IuZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcih2YWxpZGF0aW9uRXJyb3IuY29kZSwgdmFsaWRhdGlvbkVycm9yLmVycm9yKSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QodmFsaWRhdGlvbkVycm9yKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGFkYXB0ZXJTY2hlbWEgPSBhd2FpdCB0aGlzLl9kYkFkYXB0ZXIuY3JlYXRlQ2xhc3MoXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYSh7XG4gICAgICAgICAgZmllbGRzLFxuICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICBpbmRleGVzLFxuICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgICAvLyBUT0RPOiBSZW1vdmUgYnkgdXBkYXRpbmcgc2NoZW1hIGNhY2hlIGRpcmVjdGx5XG4gICAgICBhd2FpdCB0aGlzLnJlbG9hZERhdGEoeyBjbGVhckNhY2hlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgcGFyc2VTY2hlbWEgPSBjb252ZXJ0QWRhcHRlclNjaGVtYVRvUGFyc2VTY2hlbWEoYWRhcHRlclNjaGVtYSk7XG4gICAgICByZXR1cm4gcGFyc2VTY2hlbWE7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRSwgYENsYXNzICR7Y2xhc3NOYW1lfSBhbHJlYWR5IGV4aXN0cy5gKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHVwZGF0ZUNsYXNzKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEZpZWxkczogU2NoZW1hRmllbGRzLFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9uczogYW55LFxuICAgIGluZGV4ZXM6IGFueSxcbiAgICBkYXRhYmFzZTogRGF0YWJhc2VDb250cm9sbGVyXG4gICkge1xuICAgIHJldHVybiB0aGlzLmdldE9uZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICBjb25zdCBleGlzdGluZ0ZpZWxkcyA9IHNjaGVtYS5maWVsZHM7XG4gICAgICAgIE9iamVjdC5rZXlzKHN1Ym1pdHRlZEZpZWxkcykuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgICAgICBjb25zdCBmaWVsZCA9IHN1Ym1pdHRlZEZpZWxkc1tuYW1lXTtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBleGlzdGluZ0ZpZWxkc1tuYW1lXSAmJlxuICAgICAgICAgICAgZXhpc3RpbmdGaWVsZHNbbmFtZV0udHlwZSAhPT0gZmllbGQudHlwZSAmJlxuICAgICAgICAgICAgZmllbGQuX19vcCAhPT0gJ0RlbGV0ZSdcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigyNTUsIGBGaWVsZCAke25hbWV9IGV4aXN0cywgY2Fubm90IHVwZGF0ZS5gKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCFleGlzdGluZ0ZpZWxkc1tuYW1lXSAmJiBmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDI1NSwgYEZpZWxkICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZWxldGUgZXhpc3RpbmdGaWVsZHMuX3JwZXJtO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdGaWVsZHMuX3dwZXJtO1xuICAgICAgICBjb25zdCBuZXdTY2hlbWEgPSBidWlsZE1lcmdlZFNjaGVtYU9iamVjdChleGlzdGluZ0ZpZWxkcywgc3VibWl0dGVkRmllbGRzKTtcbiAgICAgICAgY29uc3QgZGVmYXVsdEZpZWxkcyA9IGRlZmF1bHRDb2x1bW5zW2NsYXNzTmFtZV0gfHwgZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQ7XG4gICAgICAgIGNvbnN0IGZ1bGxOZXdTY2hlbWEgPSBPYmplY3QuYXNzaWduKHt9LCBuZXdTY2hlbWEsIGRlZmF1bHRGaWVsZHMpO1xuICAgICAgICBjb25zdCB2YWxpZGF0aW9uRXJyb3IgPSB0aGlzLnZhbGlkYXRlU2NoZW1hRGF0YShcbiAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgbmV3U2NoZW1hLFxuICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICBPYmplY3Qua2V5cyhleGlzdGluZ0ZpZWxkcylcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKHZhbGlkYXRpb25FcnJvcikge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcih2YWxpZGF0aW9uRXJyb3IuY29kZSwgdmFsaWRhdGlvbkVycm9yLmVycm9yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZpbmFsbHkgd2UgaGF2ZSBjaGVja2VkIHRvIG1ha2Ugc3VyZSB0aGUgcmVxdWVzdCBpcyB2YWxpZCBhbmQgd2UgY2FuIHN0YXJ0IGRlbGV0aW5nIGZpZWxkcy5cbiAgICAgICAgLy8gRG8gYWxsIGRlbGV0aW9ucyBmaXJzdCwgdGhlbiBhIHNpbmdsZSBzYXZlIHRvIF9TQ0hFTUEgY29sbGVjdGlvbiB0byBoYW5kbGUgYWxsIGFkZGl0aW9ucy5cbiAgICAgICAgY29uc3QgZGVsZXRlZEZpZWxkczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgY29uc3QgaW5zZXJ0ZWRGaWVsZHMgPSBbXTtcbiAgICAgICAgT2JqZWN0LmtleXMoc3VibWl0dGVkRmllbGRzKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgaWYgKHN1Ym1pdHRlZEZpZWxkc1tmaWVsZE5hbWVdLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgICAgICBkZWxldGVkRmllbGRzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaW5zZXJ0ZWRGaWVsZHMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IGRlbGV0ZVByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgaWYgKGRlbGV0ZWRGaWVsZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGRlbGV0ZVByb21pc2UgPSB0aGlzLmRlbGV0ZUZpZWxkcyhkZWxldGVkRmllbGRzLCBjbGFzc05hbWUsIGRhdGFiYXNlKTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgZW5mb3JjZUZpZWxkcyA9IFtdO1xuICAgICAgICByZXR1cm4gKFxuICAgICAgICAgIGRlbGV0ZVByb21pc2UgLy8gRGVsZXRlIEV2ZXJ5dGhpbmdcbiAgICAgICAgICAgIC50aGVuKCgpID0+IHRoaXMucmVsb2FkRGF0YSh7IGNsZWFyQ2FjaGU6IHRydWUgfSkpIC8vIFJlbG9hZCBvdXIgU2NoZW1hLCBzbyB3ZSBoYXZlIGFsbCB0aGUgbmV3IHZhbHVlc1xuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBwcm9taXNlcyA9IGluc2VydGVkRmllbGRzLm1hcChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBzdWJtaXR0ZWRGaWVsZHNbZmllbGROYW1lXTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5lbmZvcmNlRmllbGRFeGlzdHMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgICAgICAgZW5mb3JjZUZpZWxkcyA9IHJlc3VsdHMuZmlsdGVyKHJlc3VsdCA9PiAhIXJlc3VsdCk7XG4gICAgICAgICAgICAgIHJldHVybiB0aGlzLnNldFBlcm1pc3Npb25zKGNsYXNzTmFtZSwgY2xhc3NMZXZlbFBlcm1pc3Npb25zLCBuZXdTY2hlbWEpO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC50aGVuKCgpID0+XG4gICAgICAgICAgICAgIHRoaXMuX2RiQWRhcHRlci5zZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChcbiAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgaW5kZXhlcyxcbiAgICAgICAgICAgICAgICBzY2hlbWEuaW5kZXhlcyxcbiAgICAgICAgICAgICAgICBmdWxsTmV3U2NoZW1hXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC50aGVuKCgpID0+IHRoaXMucmVsb2FkRGF0YSh7IGNsZWFyQ2FjaGU6IHRydWUgfSkpXG4gICAgICAgICAgICAvL1RPRE86IE1vdmUgdGhpcyBsb2dpYyBpbnRvIHRoZSBkYXRhYmFzZSBhZGFwdGVyXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHRoaXMuZW5zdXJlRmllbGRzKGVuZm9yY2VGaWVsZHMpO1xuICAgICAgICAgICAgICBjb25zdCBzY2hlbWEgPSB0aGlzLnNjaGVtYURhdGFbY2xhc3NOYW1lXTtcbiAgICAgICAgICAgICAgY29uc3QgcmVsb2FkZWRTY2hlbWE6IFNjaGVtYSA9IHtcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICBmaWVsZHM6IHNjaGVtYS5maWVsZHMsXG4gICAgICAgICAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiBzY2hlbWEuY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICBpZiAoc2NoZW1hLmluZGV4ZXMgJiYgT2JqZWN0LmtleXMoc2NoZW1hLmluZGV4ZXMpLmxlbmd0aCAhPT0gMCkge1xuICAgICAgICAgICAgICAgIHJlbG9hZGVkU2NoZW1hLmluZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gcmVsb2FkZWRTY2hlbWE7XG4gICAgICAgICAgICB9KVxuICAgICAgICApO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9DTEFTU19OQU1FLFxuICAgICAgICAgICAgYENsYXNzICR7Y2xhc3NOYW1lfSBkb2VzIG5vdCBleGlzdC5gXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSB0byB0aGUgbmV3IHNjaGVtYVxuICAvLyBvYmplY3Qgb3IgZmFpbHMgd2l0aCBhIHJlYXNvbi5cbiAgZW5mb3JjZUNsYXNzRXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTxTY2hlbWFDb250cm9sbGVyPiB7XG4gICAgaWYgKHRoaXMuc2NoZW1hRGF0YVtjbGFzc05hbWVdKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRoaXMpO1xuICAgIH1cbiAgICAvLyBXZSBkb24ndCBoYXZlIHRoaXMgY2xhc3MuIFVwZGF0ZSB0aGUgc2NoZW1hXG4gICAgcmV0dXJuIChcbiAgICAgIC8vIFRoZSBzY2hlbWEgdXBkYXRlIHN1Y2NlZWRlZC4gUmVsb2FkIHRoZSBzY2hlbWFcbiAgICAgIHRoaXMuYWRkQ2xhc3NJZk5vdEV4aXN0cyhjbGFzc05hbWUpXG4gICAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgLy8gVGhlIHNjaGVtYSB1cGRhdGUgZmFpbGVkLiBUaGlzIGNhbiBiZSBva2F5IC0gaXQgbWlnaHRcbiAgICAgICAgICAvLyBoYXZlIGZhaWxlZCBiZWNhdXNlIHRoZXJlJ3MgYSByYWNlIGNvbmRpdGlvbiBhbmQgYSBkaWZmZXJlbnRcbiAgICAgICAgICAvLyBjbGllbnQgaXMgbWFraW5nIHRoZSBleGFjdCBzYW1lIHNjaGVtYSB1cGRhdGUgdGhhdCB3ZSB3YW50LlxuICAgICAgICAgIC8vIFNvIGp1c3QgcmVsb2FkIHRoZSBzY2hlbWEuXG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVsb2FkRGF0YSh7IGNsZWFyQ2FjaGU6IHRydWUgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAvLyBFbnN1cmUgdGhhdCB0aGUgc2NoZW1hIG5vdyB2YWxpZGF0ZXNcbiAgICAgICAgICBpZiAodGhpcy5zY2hlbWFEYXRhW2NsYXNzTmFtZV0pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgRmFpbGVkIHRvIGFkZCAke2NsYXNzTmFtZX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgLy8gVGhlIHNjaGVtYSBzdGlsbCBkb2Vzbid0IHZhbGlkYXRlLiBHaXZlIHVwXG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ3NjaGVtYSBjbGFzcyBuYW1lIGRvZXMgbm90IHJldmFsaWRhdGUnKTtcbiAgICAgICAgfSlcbiAgICApO1xuICB9XG5cbiAgdmFsaWRhdGVOZXdDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgZmllbGRzOiBTY2hlbWFGaWVsZHMgPSB7fSwgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiBhbnkpOiBhbnkge1xuICAgIGlmICh0aGlzLnNjaGVtYURhdGFbY2xhc3NOYW1lXSkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRSwgYENsYXNzICR7Y2xhc3NOYW1lfSBhbHJlYWR5IGV4aXN0cy5gKTtcbiAgICB9XG4gICAgaWYgKCFjbGFzc05hbWVJc1ZhbGlkKGNsYXNzTmFtZSkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRSxcbiAgICAgICAgZXJyb3I6IGludmFsaWRDbGFzc05hbWVNZXNzYWdlKGNsYXNzTmFtZSksXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVNjaGVtYURhdGEoY2xhc3NOYW1lLCBmaWVsZHMsIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucywgW10pO1xuICB9XG5cbiAgdmFsaWRhdGVTY2hlbWFEYXRhKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGZpZWxkczogU2NoZW1hRmllbGRzLFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9uczogQ2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgIGV4aXN0aW5nRmllbGROYW1lczogQXJyYXk8c3RyaW5nPlxuICApIHtcbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBmaWVsZHMpIHtcbiAgICAgIGlmIChleGlzdGluZ0ZpZWxkTmFtZXMuaW5kZXhPZihmaWVsZE5hbWUpIDwgMCkge1xuICAgICAgICBpZiAoIWZpZWxkTmFtZUlzVmFsaWQoZmllbGROYW1lLCBjbGFzc05hbWUpKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICBlcnJvcjogJ2ludmFsaWQgZmllbGQgbmFtZTogJyArIGZpZWxkTmFtZSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGlmICghZmllbGROYW1lSXNWYWxpZEZvckNsYXNzKGZpZWxkTmFtZSwgY2xhc3NOYW1lKSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb2RlOiAxMzYsXG4gICAgICAgICAgICBlcnJvcjogJ2ZpZWxkICcgKyBmaWVsZE5hbWUgKyAnIGNhbm5vdCBiZSBhZGRlZCcsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBmaWVsZFR5cGUgPSBmaWVsZHNbZmllbGROYW1lXTtcbiAgICAgICAgY29uc3QgZXJyb3IgPSBmaWVsZFR5cGVJc0ludmFsaWQoZmllbGRUeXBlKTtcbiAgICAgICAgaWYgKGVycm9yKSB7IHJldHVybiB7IGNvZGU6IGVycm9yLmNvZGUsIGVycm9yOiBlcnJvci5tZXNzYWdlIH07IH1cbiAgICAgICAgaWYgKGZpZWxkVHlwZS5kZWZhdWx0VmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWVUeXBlID0gZ2V0VHlwZShmaWVsZFR5cGUuZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZVR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICBkZWZhdWx0VmFsdWVUeXBlID0geyB0eXBlOiBkZWZhdWx0VmFsdWVUeXBlIH07XG4gICAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlVHlwZSA9PT0gJ29iamVjdCcgJiYgZmllbGRUeXBlLnR5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOQ09SUkVDVF9UWVBFLFxuICAgICAgICAgICAgICBlcnJvcjogYFRoZSAnZGVmYXVsdCB2YWx1ZScgb3B0aW9uIGlzIG5vdCBhcHBsaWNhYmxlIGZvciAke3R5cGVUb1N0cmluZyhmaWVsZFR5cGUpfWAsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoIWRiVHlwZU1hdGNoZXNPYmplY3RUeXBlKGZpZWxkVHlwZSwgZGVmYXVsdFZhbHVlVHlwZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGNvZGU6IFBhcnNlLkVycm9yLklOQ09SUkVDVF9UWVBFLFxuICAgICAgICAgICAgICBlcnJvcjogYHNjaGVtYSBtaXNtYXRjaCBmb3IgJHtjbGFzc05hbWV9LiR7ZmllbGROYW1lfSBkZWZhdWx0IHZhbHVlOyBleHBlY3RlZCAke3R5cGVUb1N0cmluZyhcbiAgICAgICAgICAgICAgICBmaWVsZFR5cGVcbiAgICAgICAgICAgICAgKX0gYnV0IGdvdCAke3R5cGVUb1N0cmluZyhkZWZhdWx0VmFsdWVUeXBlKX1gLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGRUeXBlLnJlcXVpcmVkKSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiBmaWVsZFR5cGUgPT09ICdvYmplY3QnICYmIGZpZWxkVHlwZS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5JTkNPUlJFQ1RfVFlQRSxcbiAgICAgICAgICAgICAgZXJyb3I6IGBUaGUgJ3JlcXVpcmVkJyBvcHRpb24gaXMgbm90IGFwcGxpY2FibGUgZm9yICR7dHlwZVRvU3RyaW5nKGZpZWxkVHlwZSl9YCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gZGVmYXVsdENvbHVtbnNbY2xhc3NOYW1lXSkge1xuICAgICAgZmllbGRzW2ZpZWxkTmFtZV0gPSBkZWZhdWx0Q29sdW1uc1tjbGFzc05hbWVdW2ZpZWxkTmFtZV07XG4gICAgfVxuXG4gICAgY29uc3QgZ2VvUG9pbnRzID0gT2JqZWN0LmtleXMoZmllbGRzKS5maWx0ZXIoXG4gICAgICBrZXkgPT4gZmllbGRzW2tleV0gJiYgZmllbGRzW2tleV0udHlwZSA9PT0gJ0dlb1BvaW50J1xuICAgICk7XG4gICAgaWYgKGdlb1BvaW50cy5sZW5ndGggPiAxKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5JTkNPUlJFQ1RfVFlQRSxcbiAgICAgICAgZXJyb3I6XG4gICAgICAgICAgJ2N1cnJlbnRseSwgb25seSBvbmUgR2VvUG9pbnQgZmllbGQgbWF5IGV4aXN0IGluIGFuIG9iamVjdC4gQWRkaW5nICcgK1xuICAgICAgICAgIGdlb1BvaW50c1sxXSArXG4gICAgICAgICAgJyB3aGVuICcgK1xuICAgICAgICAgIGdlb1BvaW50c1swXSArXG4gICAgICAgICAgJyBhbHJlYWR5IGV4aXN0cy4nLFxuICAgICAgfTtcbiAgICB9XG4gICAgdmFsaWRhdGVDTFAoY2xhc3NMZXZlbFBlcm1pc3Npb25zLCBmaWVsZHMsIHRoaXMudXNlcklkUmVnRXgpO1xuICB9XG5cbiAgLy8gU2V0cyB0aGUgQ2xhc3MtbGV2ZWwgcGVybWlzc2lvbnMgZm9yIGEgZ2l2ZW4gY2xhc3NOYW1lLCB3aGljaCBtdXN0IGV4aXN0LlxuICBhc3luYyBzZXRQZXJtaXNzaW9ucyhjbGFzc05hbWU6IHN0cmluZywgcGVybXM6IGFueSwgbmV3U2NoZW1hOiBTY2hlbWFGaWVsZHMpIHtcbiAgICBpZiAodHlwZW9mIHBlcm1zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICB2YWxpZGF0ZUNMUChwZXJtcywgbmV3U2NoZW1hLCB0aGlzLnVzZXJJZFJlZ0V4KTtcbiAgICBhd2FpdCB0aGlzLl9kYkFkYXB0ZXIuc2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSwgcGVybXMpO1xuICAgIGNvbnN0IGNhY2hlZCA9IFNjaGVtYUNhY2hlLmdldChjbGFzc05hbWUpO1xuICAgIGlmIChjYWNoZWQpIHtcbiAgICAgIGNhY2hlZC5jbGFzc0xldmVsUGVybWlzc2lvbnMgPSBwZXJtcztcbiAgICB9XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSB0byB0aGUgbmV3IHNjaGVtYVxuICAvLyBvYmplY3QgaWYgdGhlIHByb3ZpZGVkIGNsYXNzTmFtZS1maWVsZE5hbWUtdHlwZSB0dXBsZSBpcyB2YWxpZC5cbiAgLy8gVGhlIGNsYXNzTmFtZSBtdXN0IGFscmVhZHkgYmUgdmFsaWRhdGVkLlxuICAvLyBJZiAnZnJlZXplJyBpcyB0cnVlLCByZWZ1c2UgdG8gdXBkYXRlIHRoZSBzY2hlbWEgZm9yIHRoaXMgZmllbGQuXG4gIGVuZm9yY2VGaWVsZEV4aXN0cyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBmaWVsZE5hbWU6IHN0cmluZyxcbiAgICB0eXBlOiBzdHJpbmcgfCBTY2hlbWFGaWVsZCxcbiAgICBpc1ZhbGlkYXRpb24/OiBib29sZWFuLFxuICAgIG1haW50ZW5hbmNlPzogYm9vbGVhblxuICApIHtcbiAgICBpZiAoZmllbGROYW1lLmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgIC8vIFwiPGFycmF5Pi48aW5kZXg+XCIgZm9yIE5lc3RlZCBBcnJheXNcbiAgICAgIC8vIFwiPGVtYmVkZGVkIGRvY3VtZW50Pi48ZmllbGQ+XCIgZm9yIE5lc3RlZCBPYmplY3RzXG4gICAgICAvLyBKU09OIEFycmF5cyBhcmUgdHJlYXRlZCBhcyBOZXN0ZWQgT2JqZWN0c1xuICAgICAgY29uc3QgW3gsIHldID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICBmaWVsZE5hbWUgPSB4O1xuICAgICAgY29uc3QgaXNBcnJheUluZGV4ID0gQXJyYXkuZnJvbSh5KS5ldmVyeShjID0+IGMgPj0gJzAnICYmIGMgPD0gJzknKTtcbiAgICAgIGlmIChpc0FycmF5SW5kZXggJiYgIVsnc2VudFBlclVUQ09mZnNldCcsICdmYWlsZWRQZXJVVENPZmZzZXQnXS5pbmNsdWRlcyhmaWVsZE5hbWUpKSB7XG4gICAgICAgIHR5cGUgPSAnQXJyYXknO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHlwZSA9ICdPYmplY3QnO1xuICAgICAgfVxuICAgIH1cbiAgICBsZXQgZmllbGROYW1lVG9WYWxpZGF0ZSA9IGAke2ZpZWxkTmFtZX1gO1xuICAgIGlmIChtYWludGVuYW5jZSAmJiBmaWVsZE5hbWVUb1ZhbGlkYXRlLmNoYXJBdCgwKSA9PT0gJ18nKSB7XG4gICAgICBmaWVsZE5hbWVUb1ZhbGlkYXRlID0gZmllbGROYW1lVG9WYWxpZGF0ZS5zdWJzdHJpbmcoMSk7XG4gICAgfVxuICAgIGlmICghZmllbGROYW1lSXNWYWxpZChmaWVsZE5hbWVUb1ZhbGlkYXRlLCBjbGFzc05hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSwgYEludmFsaWQgZmllbGQgbmFtZTogJHtmaWVsZE5hbWV9LmApO1xuICAgIH1cblxuICAgIC8vIElmIHNvbWVvbmUgdHJpZXMgdG8gY3JlYXRlIGEgbmV3IGZpZWxkIHdpdGggbnVsbC91bmRlZmluZWQgYXMgdGhlIHZhbHVlLCByZXR1cm47XG4gICAgaWYgKCF0eXBlKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnN0IGV4cGVjdGVkVHlwZSA9IHRoaXMuZ2V0RXhwZWN0ZWRUeXBlKGNsYXNzTmFtZSwgZmllbGROYW1lKTtcbiAgICBpZiAodHlwZW9mIHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICB0eXBlID0gKHsgdHlwZSB9OiBTY2hlbWFGaWVsZCk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGUuZGVmYXVsdFZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGxldCBkZWZhdWx0VmFsdWVUeXBlID0gZ2V0VHlwZSh0eXBlLmRlZmF1bHRWYWx1ZSk7XG4gICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZVR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIGRlZmF1bHRWYWx1ZVR5cGUgPSB7IHR5cGU6IGRlZmF1bHRWYWx1ZVR5cGUgfTtcbiAgICAgIH1cbiAgICAgIGlmICghZGJUeXBlTWF0Y2hlc09iamVjdFR5cGUodHlwZSwgZGVmYXVsdFZhbHVlVHlwZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOQ09SUkVDVF9UWVBFLFxuICAgICAgICAgIGBzY2hlbWEgbWlzbWF0Y2ggZm9yICR7Y2xhc3NOYW1lfS4ke2ZpZWxkTmFtZX0gZGVmYXVsdCB2YWx1ZTsgZXhwZWN0ZWQgJHt0eXBlVG9TdHJpbmcoXG4gICAgICAgICAgICB0eXBlXG4gICAgICAgICAgKX0gYnV0IGdvdCAke3R5cGVUb1N0cmluZyhkZWZhdWx0VmFsdWVUeXBlKX1gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGV4cGVjdGVkVHlwZSkge1xuICAgICAgaWYgKCFkYlR5cGVNYXRjaGVzT2JqZWN0VHlwZShleHBlY3RlZFR5cGUsIHR5cGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTkNPUlJFQ1RfVFlQRSxcbiAgICAgICAgICBgc2NoZW1hIG1pc21hdGNoIGZvciAke2NsYXNzTmFtZX0uJHtmaWVsZE5hbWV9OyBleHBlY3RlZCAke3R5cGVUb1N0cmluZyhcbiAgICAgICAgICAgIGV4cGVjdGVkVHlwZVxuICAgICAgICAgICl9IGJ1dCBnb3QgJHt0eXBlVG9TdHJpbmcodHlwZSl9YFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gSWYgdHlwZSBvcHRpb25zIGRvIG5vdCBjaGFuZ2VcbiAgICAgIC8vIHdlIGNhbiBzYWZlbHkgcmV0dXJuXG4gICAgICBpZiAoaXNWYWxpZGF0aW9uIHx8IEpTT04uc3RyaW5naWZ5KGV4cGVjdGVkVHlwZSkgPT09IEpTT04uc3RyaW5naWZ5KHR5cGUpKSB7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICAvLyBGaWVsZCBvcHRpb25zIGFyZSBtYXkgYmUgY2hhbmdlZFxuICAgICAgLy8gZW5zdXJlIHRvIGhhdmUgYW4gdXBkYXRlIHRvIGRhdGUgc2NoZW1hIGZpZWxkXG4gICAgICByZXR1cm4gdGhpcy5fZGJBZGFwdGVyLnVwZGF0ZUZpZWxkT3B0aW9ucyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX2RiQWRhcHRlclxuICAgICAgLmFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PSBQYXJzZS5FcnJvci5JTkNPUlJFQ1RfVFlQRSkge1xuICAgICAgICAgIC8vIE1ha2Ugc3VyZSB0aGF0IHdlIHRocm93IGVycm9ycyB3aGVuIGl0IGlzIGFwcHJvcHJpYXRlIHRvIGRvIHNvLlxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIC8vIFRoZSB1cGRhdGUgZmFpbGVkLiBUaGlzIGNhbiBiZSBva2F5IC0gaXQgbWlnaHQgaGF2ZSBiZWVuIGEgcmFjZVxuICAgICAgICAvLyBjb25kaXRpb24gd2hlcmUgYW5vdGhlciBjbGllbnQgdXBkYXRlZCB0aGUgc2NoZW1hIGluIHRoZSBzYW1lXG4gICAgICAgIC8vIHdheSB0aGF0IHdlIHdhbnRlZCB0by4gU28sIGp1c3QgcmVsb2FkIHRoZSBzY2hlbWFcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgIHR5cGUsXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgfVxuXG4gIGVuc3VyZUZpZWxkcyhmaWVsZHM6IGFueSkge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBjb25zdCB7IGNsYXNzTmFtZSwgZmllbGROYW1lIH0gPSBmaWVsZHNbaV07XG4gICAgICBsZXQgeyB0eXBlIH0gPSBmaWVsZHNbaV07XG4gICAgICBjb25zdCBleHBlY3RlZFR5cGUgPSB0aGlzLmdldEV4cGVjdGVkVHlwZShjbGFzc05hbWUsIGZpZWxkTmFtZSk7XG4gICAgICBpZiAodHlwZW9mIHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHR5cGUgPSB7IHR5cGU6IHR5cGUgfTtcbiAgICAgIH1cbiAgICAgIGlmICghZXhwZWN0ZWRUeXBlIHx8ICFkYlR5cGVNYXRjaGVzT2JqZWN0VHlwZShleHBlY3RlZFR5cGUsIHR5cGUpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBDb3VsZCBub3QgYWRkIGZpZWxkICR7ZmllbGROYW1lfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIG1haW50YWluIGNvbXBhdGliaWxpdHlcbiAgZGVsZXRlRmllbGQoZmllbGROYW1lOiBzdHJpbmcsIGNsYXNzTmFtZTogc3RyaW5nLCBkYXRhYmFzZTogRGF0YWJhc2VDb250cm9sbGVyKSB7XG4gICAgcmV0dXJuIHRoaXMuZGVsZXRlRmllbGRzKFtmaWVsZE5hbWVdLCBjbGFzc05hbWUsIGRhdGFiYXNlKTtcbiAgfVxuXG4gIC8vIERlbGV0ZSBmaWVsZHMsIGFuZCByZW1vdmUgdGhhdCBkYXRhIGZyb20gYWxsIG9iamVjdHMuIFRoaXMgaXMgaW50ZW5kZWRcbiAgLy8gdG8gcmVtb3ZlIHVudXNlZCBmaWVsZHMsIGlmIG90aGVyIHdyaXRlcnMgYXJlIHdyaXRpbmcgb2JqZWN0cyB0aGF0IGluY2x1ZGVcbiAgLy8gdGhpcyBmaWVsZCwgdGhlIGZpZWxkIG1heSByZWFwcGVhci4gUmV0dXJucyBhIFByb21pc2UgdGhhdCByZXNvbHZlcyB3aXRoXG4gIC8vIG5vIG9iamVjdCBvbiBzdWNjZXNzLCBvciByZWplY3RzIHdpdGggeyBjb2RlLCBlcnJvciB9IG9uIGZhaWx1cmUuXG4gIC8vIFBhc3NpbmcgdGhlIGRhdGFiYXNlIGFuZCBwcmVmaXggaXMgbmVjZXNzYXJ5IGluIG9yZGVyIHRvIGRyb3AgcmVsYXRpb24gY29sbGVjdGlvbnNcbiAgLy8gYW5kIHJlbW92ZSBmaWVsZHMgZnJvbSBvYmplY3RzLiBJZGVhbGx5IHRoZSBkYXRhYmFzZSB3b3VsZCBiZWxvbmcgdG9cbiAgLy8gYSBkYXRhYmFzZSBhZGFwdGVyIGFuZCB0aGlzIGZ1bmN0aW9uIHdvdWxkIGNsb3NlIG92ZXIgaXQgb3IgYWNjZXNzIGl0IHZpYSBtZW1iZXIuXG4gIGRlbGV0ZUZpZWxkcyhmaWVsZE5hbWVzOiBBcnJheTxzdHJpbmc+LCBjbGFzc05hbWU6IHN0cmluZywgZGF0YWJhc2U6IERhdGFiYXNlQ29udHJvbGxlcikge1xuICAgIGlmICghY2xhc3NOYW1lSXNWYWxpZChjbGFzc05hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9DTEFTU19OQU1FLCBpbnZhbGlkQ2xhc3NOYW1lTWVzc2FnZShjbGFzc05hbWUpKTtcbiAgICB9XG5cbiAgICBmaWVsZE5hbWVzLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmICghZmllbGROYW1lSXNWYWxpZChmaWVsZE5hbWUsIGNsYXNzTmFtZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGBpbnZhbGlkIGZpZWxkIG5hbWU6ICR7ZmllbGROYW1lfWApO1xuICAgICAgfVxuICAgICAgLy9Eb24ndCBhbGxvdyBkZWxldGluZyB0aGUgZGVmYXVsdCBmaWVsZHMuXG4gICAgICBpZiAoIWZpZWxkTmFtZUlzVmFsaWRGb3JDbGFzcyhmaWVsZE5hbWUsIGNsYXNzTmFtZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKDEzNiwgYGZpZWxkICR7ZmllbGROYW1lfSBjYW5ub3QgYmUgY2hhbmdlZGApO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHRoaXMuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSwgZmFsc2UsIHsgY2xlYXJDYWNoZTogdHJ1ZSB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUUsXG4gICAgICAgICAgICBgQ2xhc3MgJHtjbGFzc05hbWV9IGRvZXMgbm90IGV4aXN0LmBcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgZmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcigyNTUsIGBGaWVsZCAke2ZpZWxkTmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBzY2hlbWFGaWVsZHMgPSB7IC4uLnNjaGVtYS5maWVsZHMgfTtcbiAgICAgICAgcmV0dXJuIGRhdGFiYXNlLmFkYXB0ZXIuZGVsZXRlRmllbGRzKGNsYXNzTmFtZSwgc2NoZW1hLCBmaWVsZE5hbWVzKS50aGVuKCgpID0+IHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgICAgICBmaWVsZE5hbWVzLm1hcChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBmaWVsZCA9IHNjaGVtYUZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgICAgICAgICBpZiAoZmllbGQgJiYgZmllbGQudHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICAgICAgICAgIC8vRm9yIHJlbGF0aW9ucywgZHJvcCB0aGUgX0pvaW4gdGFibGVcbiAgICAgICAgICAgICAgICByZXR1cm4gZGF0YWJhc2UuYWRhcHRlci5kZWxldGVDbGFzcyhgX0pvaW46JHtmaWVsZE5hbWV9OiR7Y2xhc3NOYW1lfWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgKTtcbiAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBTY2hlbWFDYWNoZS5jbGVhcigpO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBWYWxpZGF0ZXMgYW4gb2JqZWN0IHByb3ZpZGVkIGluIFJFU1QgZm9ybWF0LlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBuZXcgc2NoZW1hIGlmIHRoaXMgb2JqZWN0IGlzXG4gIC8vIHZhbGlkLlxuICBhc3luYyB2YWxpZGF0ZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgb2JqZWN0OiBhbnksIHF1ZXJ5OiBhbnksIG1haW50ZW5hbmNlOiBib29sZWFuKSB7XG4gICAgbGV0IGdlb2NvdW50ID0gMDtcbiAgICBjb25zdCBzY2hlbWEgPSBhd2FpdCB0aGlzLmVuZm9yY2VDbGFzc0V4aXN0cyhjbGFzc05hbWUpO1xuICAgIGNvbnN0IHByb21pc2VzID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBvYmplY3QpIHtcbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSAmJiBnZXRUeXBlKG9iamVjdFtmaWVsZE5hbWVdKSA9PT0gJ0dlb1BvaW50Jykge1xuICAgICAgICBnZW9jb3VudCsrO1xuICAgICAgfVxuICAgICAgaWYgKGdlb2NvdW50ID4gMSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5DT1JSRUNUX1RZUEUsXG4gICAgICAgICAgICAndGhlcmUgY2FuIG9ubHkgYmUgb25lIGdlb3BvaW50IGZpZWxkIGluIGEgY2xhc3MnXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBvYmplY3QpIHtcbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgZXhwZWN0ZWQgPSBnZXRUeXBlKG9iamVjdFtmaWVsZE5hbWVdKTtcbiAgICAgIC8vIEEgbnVsbCB2YWx1ZSBhbmQgYSBEZWxldGUgb3AgaGF2ZSBubyB0eXBlLCB3aGljaCBza2lwcyBlbmZvcmNlRmllbGRFeGlzdHMgYW5kXG4gICAgICAvLyB3aXRoIGl0IHRoZSBydWxlIHRoYXQgYSBkb3Qgbm90YXRpb24ga2V5J3MgcGFyZW50IG11c3QgYmUgYW4gT2JqZWN0IG9yIEFycmF5XG4gICAgICAvLyBmaWVsZC4gQSBudWxsIHZhbHVlIGJlbG93IGEgbm9uLW9iamVjdCBmaWVsZCAoZS5nLiBhIFBvaW50ZXIpIGlzIHRoZW4gd3JpdHRlblxuICAgICAgLy8gYXMgYSBzdWItZG9jdW1lbnQgYW5kIGNvcnJ1cHRzIHRoZSBmaWVsZCwgc28gc3RpbGwgdmFsaWRhdGUgaXQgYXMgZm9yIGEgdHlwZWRcbiAgICAgIC8vIHZhbHVlLiBBIERlbGV0ZSBvbmx5IHJlbW92ZXMgYSBzdWItcGF0aCBhbmQgaXMgYSBuby1vcCBoZXJlLlxuICAgICAgY29uc3QgaXNOdWxsRG90Tm90YXRpb25LZXkgPSBvYmplY3RbZmllbGROYW1lXSA9PT0gbnVsbCAmJiBmaWVsZE5hbWUuaW5kZXhPZignLicpID4gMDtcbiAgICAgIGlmICghZXhwZWN0ZWQgJiYgIWlzTnVsbERvdE5vdGF0aW9uS2V5KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgLy8gRXZlcnkgb2JqZWN0IGhhcyBBQ0wgaW1wbGljaXRseS5cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBwcm9taXNlcy5wdXNoKHNjaGVtYS5lbmZvcmNlRmllbGRFeGlzdHMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIGV4cGVjdGVkLCB0cnVlLCBtYWludGVuYW5jZSkpO1xuICAgIH1cbiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICAgIGNvbnN0IGVuZm9yY2VGaWVsZHMgPSByZXN1bHRzLmZpbHRlcihyZXN1bHQgPT4gISFyZXN1bHQpO1xuXG4gICAgaWYgKGVuZm9yY2VGaWVsZHMubGVuZ3RoICE9PSAwKSB7XG4gICAgICAvLyBUT0RPOiBSZW1vdmUgYnkgdXBkYXRpbmcgc2NoZW1hIGNhY2hlIGRpcmVjdGx5XG4gICAgICBhd2FpdCB0aGlzLnJlbG9hZERhdGEoeyBjbGVhckNhY2hlOiB0cnVlIH0pO1xuICAgIH1cbiAgICB0aGlzLmVuc3VyZUZpZWxkcyhlbmZvcmNlRmllbGRzKTtcblxuICAgIGNvbnN0IHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoc2NoZW1hKTtcbiAgICByZXR1cm4gdGhlblZhbGlkYXRlUmVxdWlyZWRDb2x1bW5zKHByb21pc2UsIGNsYXNzTmFtZSwgb2JqZWN0LCBxdWVyeSk7XG4gIH1cblxuICAvLyBWYWxpZGF0ZXMgdGhhdCBhbGwgdGhlIHByb3BlcnRpZXMgYXJlIHNldCBmb3IgdGhlIG9iamVjdFxuICB2YWxpZGF0ZVJlcXVpcmVkQ29sdW1ucyhjbGFzc05hbWU6IHN0cmluZywgb2JqZWN0OiBhbnksIHF1ZXJ5OiBhbnkpIHtcbiAgICBjb25zdCBjb2x1bW5zID0gcmVxdWlyZWRDb2x1bW5zLndyaXRlW2NsYXNzTmFtZV07XG4gICAgaWYgKCFjb2x1bW5zIHx8IGNvbHVtbnMubGVuZ3RoID09IDApIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodGhpcyk7XG4gICAgfVxuXG4gICAgY29uc3QgbWlzc2luZ0NvbHVtbnMgPSBjb2x1bW5zLmZpbHRlcihmdW5jdGlvbiAoY29sdW1uKSB7XG4gICAgICBpZiAocXVlcnkgJiYgcXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgaWYgKG9iamVjdFtjb2x1bW5dICYmIHR5cGVvZiBvYmplY3RbY29sdW1uXSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAvLyBUcnlpbmcgdG8gZGVsZXRlIGEgcmVxdWlyZWQgY29sdW1uXG4gICAgICAgICAgcmV0dXJuIG9iamVjdFtjb2x1bW5dLl9fb3AgPT0gJ0RlbGV0ZSc7XG4gICAgICAgIH1cbiAgICAgICAgLy8gTm90IHRyeWluZyB0byBkbyBhbnl0aGluZyB0aGVyZVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gIW9iamVjdFtjb2x1bW5dO1xuICAgIH0pO1xuXG4gICAgaWYgKG1pc3NpbmdDb2x1bW5zLmxlbmd0aCA+IDApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTkNPUlJFQ1RfVFlQRSwgbWlzc2luZ0NvbHVtbnNbMF0gKyAnIGlzIHJlcXVpcmVkLicpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRoaXMpO1xuICB9XG5cbiAgdGVzdFBlcm1pc3Npb25zRm9yQ2xhc3NOYW1lKGNsYXNzTmFtZTogc3RyaW5nLCBhY2xHcm91cDogc3RyaW5nW10sIG9wZXJhdGlvbjogc3RyaW5nKSB7XG4gICAgcmV0dXJuIFNjaGVtYUNvbnRyb2xsZXIudGVzdFBlcm1pc3Npb25zKFxuICAgICAgdGhpcy5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKSxcbiAgICAgIGFjbEdyb3VwLFxuICAgICAgb3BlcmF0aW9uXG4gICAgKTtcbiAgfVxuXG4gIC8vIFRlc3RzIHRoYXQgdGhlIGNsYXNzIGxldmVsIHBlcm1pc3Npb24gbGV0IHBhc3MgdGhlIG9wZXJhdGlvbiBmb3IgYSBnaXZlbiBhY2xHcm91cFxuICBzdGF0aWMgdGVzdFBlcm1pc3Npb25zKGNsYXNzUGVybWlzc2lvbnM6ID9hbnksIGFjbEdyb3VwOiBzdHJpbmdbXSwgb3BlcmF0aW9uOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICBpZiAoIWNsYXNzUGVybWlzc2lvbnMgfHwgIWNsYXNzUGVybWlzc2lvbnNbb3BlcmF0aW9uXSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGNvbnN0IHBlcm1zID0gY2xhc3NQZXJtaXNzaW9uc1tvcGVyYXRpb25dO1xuICAgIGlmIChwZXJtc1snKiddKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQ2hlY2sgcGVybWlzc2lvbnMgYWdhaW5zdCB0aGUgYWNsR3JvdXAgcHJvdmlkZWQgKGFycmF5IG9mIHVzZXJJZC9yb2xlcylcbiAgICBpZiAoXG4gICAgICBhY2xHcm91cC5zb21lKGFjbCA9PiB7XG4gICAgICAgIHJldHVybiBwZXJtc1thY2xdID09PSB0cnVlO1xuICAgICAgfSlcbiAgICApIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBUaGUgZGVuaWFsIG9mIGFuIG9wZXJhdGlvbiBieSB0aGUgY2xhc3MtbGV2ZWwgcGVybWlzc2lvbnMsIG9yIHVuZGVmaW5lZCBpZiB0aGV5IGxldCBpdCBwYXNzXG4gIHN0YXRpYyBwZXJtaXNzaW9uRGVuaWFsKFxuICAgIGNsYXNzUGVybWlzc2lvbnM6ID9hbnksXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgYWNsR3JvdXA6IHN0cmluZ1tdLFxuICAgIG9wZXJhdGlvbjogc3RyaW5nLFxuICAgIGFjdGlvbj86IHN0cmluZ1xuICApOiA/eyBjb2RlOiBudW1iZXIsIG1lc3NhZ2U6IHN0cmluZyB9IHtcbiAgICBpZiAoU2NoZW1hQ29udHJvbGxlci50ZXN0UGVybWlzc2lvbnMoY2xhc3NQZXJtaXNzaW9ucywgYWNsR3JvdXAsIG9wZXJhdGlvbikpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcGVybXMgPSBjbGFzc1Blcm1pc3Npb25zW29wZXJhdGlvbl07XG4gICAgLy8gSWYgb25seSBmb3IgYXV0aGVudGljYXRlZCB1c2Vyc1xuICAgIC8vIG1ha2Ugc3VyZSB3ZSBoYXZlIGFuIGFjbEdyb3VwXG4gICAgaWYgKHBlcm1zWydyZXF1aXJlc0F1dGhlbnRpY2F0aW9uJ10pIHtcbiAgICAgIC8vIElmIGFjbEdyb3VwIGhhcyAqIChwdWJsaWMpXG4gICAgICBpZiAoXG4gICAgICAgICFhY2xHcm91cCB8fFxuICAgICAgICBhY2xHcm91cC5sZW5ndGggPT0gMCB8fFxuICAgICAgICAoYWNsR3JvdXAuaW5kZXhPZignKicpID4gLTEgJiYgYWNsR3JvdXAubGVuZ3RoID09IDEpXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgIG1lc3NhZ2U6ICdQZXJtaXNzaW9uIGRlbmllZCwgdXNlciBuZWVkcyB0byBiZSBhdXRoZW50aWNhdGVkLicsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICAvLyByZXF1aXJlc0F1dGhlbnRpY2F0aW9uIHBhc3NlZCwganVzdCBtb3ZlIGZvcndhcmRcbiAgICAgIC8vIHByb2JhYmx5IHdvdWxkIGJlIHdpc2UgYXQgc29tZSBwb2ludCB0byByZW5hbWUgdG8gJ2F1dGhlbnRpY2F0ZWRVc2VyJ1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBmb3JiaWRkZW4gPSB7XG4gICAgICBjb2RlOiBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgbWVzc2FnZTogYFBlcm1pc3Npb24gZGVuaWVkIGZvciBhY3Rpb24gJHtvcGVyYXRpb259IG9uIGNsYXNzICR7Y2xhc3NOYW1lfS5gLFxuICAgIH07XG5cbiAgICAvLyBObyBtYXRjaGluZyBDTFAsIGxldCdzIGNoZWNrIHRoZSBQb2ludGVyIHBlcm1pc3Npb25zXG4gICAgLy8gQW5kIGhhbmRsZSB0aG9zZSBsYXRlclxuICAgIGNvbnN0IHBlcm1pc3Npb25GaWVsZCA9XG4gICAgICBbJ2dldCcsICdmaW5kJywgJ2NvdW50J10uaW5kZXhPZihvcGVyYXRpb24pID4gLTEgPyAncmVhZFVzZXJGaWVsZHMnIDogJ3dyaXRlVXNlckZpZWxkcyc7XG5cbiAgICAvLyBSZWplY3QgY3JlYXRlIHdoZW4gd3JpdGUgbG9ja2Rvd25cbiAgICBpZiAocGVybWlzc2lvbkZpZWxkID09ICd3cml0ZVVzZXJGaWVsZHMnICYmIG9wZXJhdGlvbiA9PSAnY3JlYXRlJykge1xuICAgICAgcmV0dXJuIGZvcmJpZGRlbjtcbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIHRoZSByZWFkVXNlckZpZWxkcyBsYXRlclxuICAgIGlmIChcbiAgICAgIEFycmF5LmlzQXJyYXkoY2xhc3NQZXJtaXNzaW9uc1twZXJtaXNzaW9uRmllbGRdKSAmJlxuICAgICAgY2xhc3NQZXJtaXNzaW9uc1twZXJtaXNzaW9uRmllbGRdLmxlbmd0aCA+IDBcbiAgICApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBwb2ludGVyRmllbGRzID0gY2xhc3NQZXJtaXNzaW9uc1tvcGVyYXRpb25dLnBvaW50ZXJGaWVsZHM7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocG9pbnRlckZpZWxkcykgJiYgcG9pbnRlckZpZWxkcy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBhbnkgb3AgZXhjZXB0ICdhZGRGaWVsZCBhcyBwYXJ0IG9mIGNyZWF0ZScgaXMgb2suXG4gICAgICBpZiAob3BlcmF0aW9uICE9PSAnYWRkRmllbGQnIHx8IGFjdGlvbiA9PT0gJ3VwZGF0ZScpIHtcbiAgICAgICAgLy8gV2UgY2FuIGFsbG93IGFkZGluZyBmaWVsZCBvbiB1cGRhdGUgZmxvdyBvbmx5LlxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmb3JiaWRkZW47XG4gIH1cblxuICAvLyBWYWxpZGF0ZXMgYW4gb3BlcmF0aW9uIHBhc3NlcyBjbGFzcy1sZXZlbC1wZXJtaXNzaW9ucyBzZXQgaW4gdGhlIHNjaGVtYVxuICBzdGF0aWMgdmFsaWRhdGVQZXJtaXNzaW9uKFxuICAgIGNsYXNzUGVybWlzc2lvbnM6ID9hbnksXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgYWNsR3JvdXA6IHN0cmluZ1tdLFxuICAgIG9wZXJhdGlvbjogc3RyaW5nLFxuICAgIGFjdGlvbj86IHN0cmluZ1xuICApIHtcbiAgICBjb25zdCBkZW5pYWwgPSBTY2hlbWFDb250cm9sbGVyLnBlcm1pc3Npb25EZW5pYWwoXG4gICAgICBjbGFzc1Blcm1pc3Npb25zLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgYWNsR3JvdXAsXG4gICAgICBvcGVyYXRpb24sXG4gICAgICBhY3Rpb25cbiAgICApO1xuICAgIGlmIChkZW5pYWwpIHtcbiAgICAgIHRocm93IGNyZWF0ZVNhbml0aXplZEVycm9yKGRlbmlhbC5jb2RlLCBkZW5pYWwubWVzc2FnZSwgQ29uZmlnLmdldChQYXJzZS5hcHBsaWNhdGlvbklkKSk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFRlc3RzIHRoYXQgdGhlIHBvaW50ZXIgcGVybWlzc2lvbnMgb2YgYW4gb3BlcmF0aW9uIGxldCB0aGUgdXNlciBhY2Nlc3MgdGhlIG9iamVjdFxuICBzdGF0aWMgdGVzdFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICBjbGFzc1Blcm1pc3Npb25zOiA/YW55LFxuICAgIGFjbEdyb3VwOiBzdHJpbmdbXSxcbiAgICBvcGVyYXRpb246IHN0cmluZyxcbiAgICB1c2VySWQ6ID9zdHJpbmcsXG4gICAgZ2V0VmFsdWU6IChmaWVsZDogc3RyaW5nKSA9PiBhbnlcbiAgKTogYm9vbGVhbiB7XG4gICAgaWYgKCFjbGFzc1Blcm1pc3Npb25zKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3QgcGVybWlzc2lvbkZpZWxkID1cbiAgICAgIFsnZ2V0JywgJ2ZpbmQnLCAnY291bnQnXS5pbmRleE9mKG9wZXJhdGlvbikgPiAtMSA/ICdyZWFkVXNlckZpZWxkcycgOiAnd3JpdGVVc2VyRmllbGRzJztcbiAgICBjb25zdCBwb2ludGVyRmllbGRzID0gW107XG4gICAgaWYgKGNsYXNzUGVybWlzc2lvbnNbb3BlcmF0aW9uXT8ucG9pbnRlckZpZWxkcykge1xuICAgICAgcG9pbnRlckZpZWxkcy5wdXNoKC4uLmNsYXNzUGVybWlzc2lvbnNbb3BlcmF0aW9uXS5wb2ludGVyRmllbGRzKTtcbiAgICB9XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoY2xhc3NQZXJtaXNzaW9uc1twZXJtaXNzaW9uRmllbGRdKSkge1xuICAgICAgZm9yIChjb25zdCBmaWVsZCBvZiBjbGFzc1Blcm1pc3Npb25zW3Blcm1pc3Npb25GaWVsZF0pIHtcbiAgICAgICAgaWYgKCFwb2ludGVyRmllbGRzLmluY2x1ZGVzKGZpZWxkKSkge1xuICAgICAgICAgIHBvaW50ZXJGaWVsZHMucHVzaChmaWVsZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQSBwdWJsaWMgb3IgdXNlci1zcGVjaWZpYyBwZXJtaXNzaW9uIGdyYW50cyBhY2Nlc3Mgd2l0aG91dCBhIHBvaW50ZXJcbiAgICBpZiAoXG4gICAgICAhcG9pbnRlckZpZWxkcy5sZW5ndGggfHxcbiAgICAgIFNjaGVtYUNvbnRyb2xsZXIudGVzdFBlcm1pc3Npb25zKGNsYXNzUGVybWlzc2lvbnMsIGFjbEdyb3VwLCBvcGVyYXRpb24pXG4gICAgKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKCF1c2VySWQpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gQSBwb2ludGVyIHRvIHRoZSB1c2VyLCBhcyBhIFBhcnNlLk9iamVjdCBvciBpbiBKU09OXG4gICAgY29uc3QgcG9pbnRzVG9Vc2VyID0gdmFsdWUgPT5cbiAgICAgIHZhbHVlIGluc3RhbmNlb2YgUGFyc2UuT2JqZWN0XG4gICAgICAgID8gdmFsdWUuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHZhbHVlLmlkID09PSB1c2VySWRcbiAgICAgICAgOiB2YWx1ZT8uX190eXBlID09PSAnUG9pbnRlcicgJiYgdmFsdWUuY2xhc3NOYW1lID09PSAnX1VzZXInICYmIHZhbHVlLm9iamVjdElkID09PSB1c2VySWQ7XG4gICAgcmV0dXJuIHBvaW50ZXJGaWVsZHMuc29tZShmaWVsZCA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGdldFZhbHVlKGZpZWxkKTtcbiAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSA/IHZhbHVlLnNvbWUocG9pbnRzVG9Vc2VyKSA6IHBvaW50c1RvVXNlcih2YWx1ZSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBWYWxpZGF0ZXMgYW4gb3BlcmF0aW9uIHBhc3NlcyBjbGFzcy1sZXZlbC1wZXJtaXNzaW9ucyBzZXQgaW4gdGhlIHNjaGVtYVxuICB2YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lOiBzdHJpbmcsIGFjbEdyb3VwOiBzdHJpbmdbXSwgb3BlcmF0aW9uOiBzdHJpbmcsIGFjdGlvbj86IHN0cmluZykge1xuICAgIHJldHVybiBTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICAgIHRoaXMuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSksXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBhY2xHcm91cCxcbiAgICAgIG9wZXJhdGlvbixcbiAgICAgIGFjdGlvblxuICAgICk7XG4gIH1cblxuICBnZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lOiBzdHJpbmcpOiBhbnkge1xuICAgIHJldHVybiB0aGlzLnNjaGVtYURhdGFbY2xhc3NOYW1lXSAmJiB0aGlzLnNjaGVtYURhdGFbY2xhc3NOYW1lXS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gIH1cblxuICAvLyBSZXR1cm5zIHRoZSBleHBlY3RlZCB0eXBlIGZvciBhIGNsYXNzTmFtZStrZXkgY29tYmluYXRpb25cbiAgLy8gb3IgdW5kZWZpbmVkIGlmIHRoZSBzY2hlbWEgaXMgbm90IHNldFxuICBnZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nKTogPyhTY2hlbWFGaWVsZCB8IHN0cmluZykge1xuICAgIGlmICh0aGlzLnNjaGVtYURhdGFbY2xhc3NOYW1lXSkge1xuICAgICAgY29uc3QgZXhwZWN0ZWRUeXBlID0gdGhpcy5zY2hlbWFEYXRhW2NsYXNzTmFtZV0uZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICByZXR1cm4gZXhwZWN0ZWRUeXBlID09PSAnbWFwJyA/ICdPYmplY3QnIDogZXhwZWN0ZWRUeXBlO1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLy8gQ2hlY2tzIGlmIGEgZ2l2ZW4gY2xhc3MgaXMgaW4gdGhlIHNjaGVtYS5cbiAgaGFzQ2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5zY2hlbWFEYXRhW2NsYXNzTmFtZV0pIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnJlbG9hZERhdGEoKS50aGVuKCgpID0+ICEhdGhpcy5zY2hlbWFEYXRhW2NsYXNzTmFtZV0pO1xuICB9XG59XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhIG5ldyBTY2hlbWEuXG5jb25zdCBsb2FkID0gKGRiQWRhcHRlcjogU3RvcmFnZUFkYXB0ZXIsIG9wdGlvbnM6IGFueSk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlcj4gPT4ge1xuICBjb25zdCBzY2hlbWEgPSBuZXcgU2NoZW1hQ29udHJvbGxlcihkYkFkYXB0ZXIpO1xuICB0dGwuZHVyYXRpb24gPSBkYkFkYXB0ZXIuc2NoZW1hQ2FjaGVUdGw7XG4gIHJldHVybiBzY2hlbWEucmVsb2FkRGF0YShvcHRpb25zKS50aGVuKCgpID0+IHNjaGVtYSk7XG59O1xuXG4vLyBCdWlsZHMgYSBuZXcgc2NoZW1hIChpbiBzY2hlbWEgQVBJIHJlc3BvbnNlIGZvcm1hdCkgb3V0IG9mIGFuXG4vLyBleGlzdGluZyBtb25nbyBzY2hlbWEgKyBhIHNjaGVtYXMgQVBJIHB1dCByZXF1ZXN0LiBUaGlzIHJlc3BvbnNlXG4vLyBkb2VzIG5vdCBpbmNsdWRlIHRoZSBkZWZhdWx0IGZpZWxkcywgYXMgaXQgaXMgaW50ZW5kZWQgdG8gYmUgcGFzc2VkXG4vLyB0byBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWUuIE5vIHZhbGlkYXRpb24gaXMgZG9uZSBoZXJlLCBpdFxuLy8gaXMgZG9uZSBpbiBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWUuXG5mdW5jdGlvbiBidWlsZE1lcmdlZFNjaGVtYU9iamVjdChleGlzdGluZ0ZpZWxkczogU2NoZW1hRmllbGRzLCBwdXRSZXF1ZXN0OiBhbnkpOiBTY2hlbWFGaWVsZHMge1xuICBjb25zdCBuZXdTY2hlbWEgPSB7fTtcbiAgLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG4gIGNvbnN0IHN5c1NjaGVtYUZpZWxkID1cbiAgICBPYmplY3Qua2V5cyhkZWZhdWx0Q29sdW1ucykuaW5kZXhPZihleGlzdGluZ0ZpZWxkcy5faWQpID09PSAtMVxuICAgICAgPyBbXVxuICAgICAgOiBPYmplY3Qua2V5cyhkZWZhdWx0Q29sdW1uc1tleGlzdGluZ0ZpZWxkcy5faWRdKTtcbiAgZm9yIChjb25zdCBvbGRGaWVsZCBpbiBleGlzdGluZ0ZpZWxkcykge1xuICAgIGlmIChcbiAgICAgIG9sZEZpZWxkICE9PSAnX2lkJyAmJlxuICAgICAgb2xkRmllbGQgIT09ICdBQ0wnICYmXG4gICAgICBvbGRGaWVsZCAhPT0gJ3VwZGF0ZWRBdCcgJiZcbiAgICAgIG9sZEZpZWxkICE9PSAnY3JlYXRlZEF0JyAmJlxuICAgICAgb2xkRmllbGQgIT09ICdvYmplY3RJZCdcbiAgICApIHtcbiAgICAgIGlmIChzeXNTY2hlbWFGaWVsZC5sZW5ndGggPiAwICYmIHN5c1NjaGVtYUZpZWxkLmluZGV4T2Yob2xkRmllbGQpICE9PSAtMSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZpZWxkSXNEZWxldGVkID0gcHV0UmVxdWVzdFtvbGRGaWVsZF0gJiYgcHV0UmVxdWVzdFtvbGRGaWVsZF0uX19vcCA9PT0gJ0RlbGV0ZSc7XG4gICAgICBpZiAoIWZpZWxkSXNEZWxldGVkKSB7XG4gICAgICAgIG5ld1NjaGVtYVtvbGRGaWVsZF0gPSBleGlzdGluZ0ZpZWxkc1tvbGRGaWVsZF07XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgbmV3RmllbGQgaW4gcHV0UmVxdWVzdCkge1xuICAgIGlmIChuZXdGaWVsZCAhPT0gJ29iamVjdElkJyAmJiBwdXRSZXF1ZXN0W25ld0ZpZWxkXS5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgaWYgKHN5c1NjaGVtYUZpZWxkLmxlbmd0aCA+IDAgJiYgc3lzU2NoZW1hRmllbGQuaW5kZXhPZihuZXdGaWVsZCkgIT09IC0xKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgbmV3U2NoZW1hW25ld0ZpZWxkXSA9IHB1dFJlcXVlc3RbbmV3RmllbGRdO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbmV3U2NoZW1hO1xufVxuXG4vLyBHaXZlbiBhIHNjaGVtYSBwcm9taXNlLCBjb25zdHJ1Y3QgYW5vdGhlciBzY2hlbWEgcHJvbWlzZSB0aGF0XG4vLyB2YWxpZGF0ZXMgdGhpcyBmaWVsZCBvbmNlIHRoZSBzY2hlbWEgbG9hZHMuXG5mdW5jdGlvbiB0aGVuVmFsaWRhdGVSZXF1aXJlZENvbHVtbnMoc2NoZW1hUHJvbWlzZSwgY2xhc3NOYW1lLCBvYmplY3QsIHF1ZXJ5KSB7XG4gIHJldHVybiBzY2hlbWFQcm9taXNlLnRoZW4oc2NoZW1hID0+IHtcbiAgICByZXR1cm4gc2NoZW1hLnZhbGlkYXRlUmVxdWlyZWRDb2x1bW5zKGNsYXNzTmFtZSwgb2JqZWN0LCBxdWVyeSk7XG4gIH0pO1xufVxuXG4vLyBHZXRzIHRoZSB0eXBlIGZyb20gYSBSRVNUIEFQSSBmb3JtYXR0ZWQgb2JqZWN0LCB3aGVyZSAndHlwZScgaXNcbi8vIGV4dGVuZGVkIHBhc3QgamF2YXNjcmlwdCB0eXBlcyB0byBpbmNsdWRlIHRoZSByZXN0IG9mIHRoZSBQYXJzZVxuLy8gdHlwZSBzeXN0ZW0uXG4vLyBUaGUgb3V0cHV0IHNob3VsZCBiZSBhIHZhbGlkIHNjaGVtYSB2YWx1ZS5cbi8vIFRPRE86IGVuc3VyZSB0aGF0IHRoaXMgaXMgY29tcGF0aWJsZSB3aXRoIHRoZSBmb3JtYXQgdXNlZCBpbiBPcGVuIERCXG5mdW5jdGlvbiBnZXRUeXBlKG9iajogYW55KTogPyhTY2hlbWFGaWVsZCB8IHN0cmluZykge1xuICBjb25zdCB0eXBlID0gdHlwZW9mIG9iajtcbiAgc3dpdGNoICh0eXBlKSB7XG4gICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICByZXR1cm4gJ0Jvb2xlYW4nO1xuICAgIGNhc2UgJ3N0cmluZyc6XG4gICAgICByZXR1cm4gJ1N0cmluZyc7XG4gICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgIHJldHVybiAnTnVtYmVyJztcbiAgICBjYXNlICdtYXAnOlxuICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICBpZiAoIW9iaikge1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGdldE9iamVjdFR5cGUob2JqKTtcbiAgICBjYXNlICdmdW5jdGlvbic6XG4gICAgY2FzZSAnc3ltYm9sJzpcbiAgICBjYXNlICd1bmRlZmluZWQnOlxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyAnYmFkIG9iajogJyArIG9iajtcbiAgfVxufVxuXG4vLyBUaGlzIGdldHMgdGhlIHR5cGUgZm9yIG5vbi1KU09OIHR5cGVzIGxpa2UgcG9pbnRlcnMgYW5kIGZpbGVzLCBidXRcbi8vIGFsc28gZ2V0cyB0aGUgYXBwcm9wcmlhdGUgdHlwZSBmb3IgJCBvcGVyYXRvcnMuXG4vLyBSZXR1cm5zIG51bGwgaWYgdGhlIHR5cGUgaXMgdW5rbm93bi5cbmZ1bmN0aW9uIGdldE9iamVjdFR5cGUob2JqKTogPyhTY2hlbWFGaWVsZCB8IHN0cmluZykge1xuICBpZiAoQXJyYXkuaXNBcnJheShvYmopKSB7XG4gICAgcmV0dXJuICdBcnJheSc7XG4gIH1cbiAgaWYgKG9iai5fX3R5cGUpIHtcbiAgICBzd2l0Y2ggKG9iai5fX3R5cGUpIHtcbiAgICAgIGNhc2UgJ1BvaW50ZXInOlxuICAgICAgICBpZiAob2JqLmNsYXNzTmFtZSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB0eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICB0YXJnZXRDbGFzczogb2JqLmNsYXNzTmFtZSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUmVsYXRpb24nOlxuICAgICAgICBpZiAob2JqLmNsYXNzTmFtZSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB0eXBlOiAnUmVsYXRpb24nLFxuICAgICAgICAgICAgdGFyZ2V0Q2xhc3M6IG9iai5jbGFzc05hbWUsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ0ZpbGUnOlxuICAgICAgICBpZiAob2JqLm5hbWUpIHtcbiAgICAgICAgICByZXR1cm4gJ0ZpbGUnO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnRGF0ZSc6XG4gICAgICAgIGlmIChvYmouaXNvKSB7XG4gICAgICAgICAgcmV0dXJuICdEYXRlJztcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ0dlb1BvaW50JzpcbiAgICAgICAgaWYgKG9iai5sYXRpdHVkZSAhPSBudWxsICYmIG9iai5sb25naXR1ZGUgIT0gbnVsbCkge1xuICAgICAgICAgIHJldHVybiAnR2VvUG9pbnQnO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnQnl0ZXMnOlxuICAgICAgICBpZiAob2JqLmJhc2U2NCkge1xuICAgICAgICAgIHJldHVybiAnQnl0ZXMnO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUG9seWdvbic6XG4gICAgICAgIGlmIChvYmouY29vcmRpbmF0ZXMpIHtcbiAgICAgICAgICByZXR1cm4gJ1BvbHlnb24nO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5DT1JSRUNUX1RZUEUsICdUaGlzIGlzIG5vdCBhIHZhbGlkICcgKyBvYmouX190eXBlKTtcbiAgfVxuICBpZiAob2JqWyckbmUnXSkge1xuICAgIHJldHVybiBnZXRPYmplY3RUeXBlKG9ialsnJG5lJ10pO1xuICB9XG4gIGlmIChvYmouX19vcCkge1xuICAgIHN3aXRjaCAob2JqLl9fb3ApIHtcbiAgICAgIGNhc2UgJ0luY3JlbWVudCc6XG4gICAgICAgIHJldHVybiAnTnVtYmVyJztcbiAgICAgIGNhc2UgJ0RlbGV0ZSc6XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgY2FzZSAnQWRkJzpcbiAgICAgIGNhc2UgJ0FkZFVuaXF1ZSc6XG4gICAgICBjYXNlICdSZW1vdmUnOlxuICAgICAgICByZXR1cm4gJ0FycmF5JztcbiAgICAgIGNhc2UgJ0FkZFJlbGF0aW9uJzpcbiAgICAgIGNhc2UgJ1JlbW92ZVJlbGF0aW9uJzpcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eXBlOiAnUmVsYXRpb24nLFxuICAgICAgICAgIHRhcmdldENsYXNzOiBvYmoub2JqZWN0c1swXS5jbGFzc05hbWUsXG4gICAgICAgIH07XG4gICAgICBjYXNlICdCYXRjaCc6XG4gICAgICAgIHJldHVybiBnZXRPYmplY3RUeXBlKG9iai5vcHNbMF0pO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgJ3VuZXhwZWN0ZWQgb3A6ICcgKyBvYmouX19vcDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuICdPYmplY3QnO1xufVxuXG5leHBvcnQge1xuICBsb2FkLFxuICBjbGFzc05hbWVJc1ZhbGlkLFxuICBmaWVsZE5hbWVJc1ZhbGlkLFxuICBpbnZhbGlkQ2xhc3NOYW1lTWVzc2FnZSxcbiAgYnVpbGRNZXJnZWRTY2hlbWFPYmplY3QsXG4gIHN5c3RlbUNsYXNzZXMsXG4gIGRlZmF1bHRDb2x1bW5zLFxuICBjb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hLFxuICBWb2xhdGlsZUNsYXNzZXNTY2hlbWFzLFxuICBTY2hlbWFDb250cm9sbGVyLFxuICByZXF1aXJlZENvbHVtbnMsXG59O1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7QUFrQkEsSUFBQUEsZUFBQSxHQUFBQyxPQUFBO0FBQ0EsSUFBQUMsWUFBQSxHQUFBQyxzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQUcsbUJBQUEsR0FBQUQsc0JBQUEsQ0FBQUYsT0FBQTtBQUNBLElBQUFJLE9BQUEsR0FBQUYsc0JB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