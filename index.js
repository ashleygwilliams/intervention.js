// EventEmitter Construction
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits

// npm Public Registry
var changesStream = require('changes-stream')
var normalize = require('normalize-registry-metadata')
var maxSatisfying = require('semver').maxSatisfying

// Utilities
var pressureStream = require('pressure-stream')
var pump = require('pump')

// Flow Control
var asyncMap = require('async.map')
var mapSeries = require('async.mapseries')
var runParallel = require('run-parallel')

module.exports = Intervention

function Intervention (levelup, fromSequence) {
  if (fromSequence !== undefined && !validSequence(fromSequence)) {
    throw new Error('invalid sequence number')
  }
  if (!(this instanceof Intervention)) {
    return new Intervention(levelup, fromSequence)
  }
  this._fromSequence = fromSequence || 0
  this._levelup = levelup
  // The last-processed change sequence number.
  this._sequence = 0
  // Data about npm users for which to emit events.
  this._emittingEventsFor = {}
}

inherits(Intervention, EventEmitter)

var prototype = Intervention.prototype

// Public API

// Get the current change sequence number.
prototype.sequence = function () { return this._sequence }

// Emit events for an npm user.
prototype.emitEventsFor = function (user, devDependencies, from) {
  if (!validUser(user)) throw new Error('invalid user')
  if (from !== undefined && !validSequence(from)) {
    throw new Error('invalid sequence number')
  }
  this._emittingEventsFor[user] = {
    // By default, emit events for dependencies, not devDependencies.
    events: devDependencies
      ? ['dependency', 'devDependency']
      : ['dependency'],
    // Emit events for changes after the current sequence number.
    from: from || (this.sequence() + 1)
  }
  return this
}

// Start streaming changes and emitting events.
prototype.start = function () {
  var self = this
  var pressure = self._pressure =
  pressureStream(function (change, next) {
    self._onChange(change, function (error, data) {
      if (error) return next(error)
      self._setSequence(change.seq, next)
    })
  }, {high: 1, max: 1, low: 1})
  var changes = self._changes = changesStream({
    db: 'https://replicate.npmjs.com',
    include_docs: true,
    since: self._fromSequence
  })
  pump(changes, pressure)
  .on('error', function (error) {
    self.emit('error', error)
  })
}

prototype.stop = function () {
  this._changes.destroy()
}

// Private Prototype Functions

prototype._onChange = function (change, done) {
  var self = this
  self._sequence = change.seq
  var doc = change.doc
  if (doc.name && doc.versions) { // Registry publish.
    doc = normalize(doc)
    var name = doc.name
    // Extract relevant data for each version of the package described
    // by the change document.
    var versions = Object.keys(doc.versions)
    .map(function extractRelevantData (semver) {
      var data = doc.versions[semver]
      var returned = {
        semver: semver,
        author: null,
        contributors: [],
        dependencies: data.dependencies,
        devDependencies: data.devDependencies
      }
      if (data.author && data.author.email && isString(data.author.email)) {
        returned.author = data.author.email
      }
      if (data.contributors && Array.isArray(data.contributors)) {
        data.contributors.forEach(function (contributor) {
          if (contributor.email && isString(contributor.email)) {
            returned.contributors.push(contributor.email)
          }
        })
      }
      return returned
    })
    // Prepare a batch of LevelUP put operations.
    var batch = []
    versions.forEach(function addBatchOperationsFor (version) {
      var semver = version.semver
      // Put `name/semver` -> {dependencies, devDependencies}
      batch.push(putOperation(packageKey(name, semver), version))
    })
    // Commit the batch.
    self._levelup.batch(batch, function (error) {
      if (error) {
        self.emit('error', error)
        done()
      }
      // Emit events.
      mapSeries(versions, function (version, done) {
        self._emitEvents(
          name, version.semver,
          version.dependencies, version.devDependencies,
          done
        )
      }, done)
    })
  } else { // CouchDB design doc.
    done()
  }
}

prototype._emitEvents = function (
  name, semver, dependencies, devDependencies, callback
) {
  // Emit `dependency` and `devDependency` events.
  var depending = {name: name, semver: semver}
  var emitEvent = this._emitEvent.bind(this)
  runParallel([
    function (done) {
      if (dependencies) {
        emitEvent('dependency', depending, dependencies, done)
      } else done()
    },
    function (done) {
      if (devDependencies) {
        emitEvent('devDependency', depending, devDependencies, done)
      } else done()
    }
  ], callback)
}

prototype._emitEvent = function (event, depending, dependencies, callback) {
  var self = this
  var sequence = self.sequence()
  // Check each dependency of the new package version.
  asyncMap(
    // Turn:
    //     {x: '^1.0.0', y: '^2.0.0'}
    // into:
    //     [
    //       {name: 'x', range: '^1.0.0'},
    //       {name: 'y', range: '^2.0.0'}
    //     ]
    Object.keys(dependencies).map(function (name) {
      return {name: name, range: dependencies[name]}
    }),
    function emitEventsFor (dependency, done) {
      // List all known versions of the dependency.
      var name = dependency.name
      self._semversOf(name, function (error, versions) {
        if (error) return done(error)
        if (versions.length === 0) return done()
        // Find the highest version that satisfies the dependency range.
        var max = maxSatisfying(versions, dependency.range)
        if (max === null) return done()
        // Find the author and users behind that dependency.
        self._usersBehind(name, max, function (error, users) {
          if (error) return done(error)
          if (users.length === 0) return done()
          // For the author and each contributor...
          users.forEach(function (user) {
            var options = self._emittingEventsFor[user]
            // Not emitting events for this user.
            if (options === undefined) return
            // Not emitting this kind of event for the user.
            if (options.events.indexOf(event) === -1) return
            // Not emitting notifications for this user at this sequence.
            if (options.from > sequence) return
            // It's a match. Emit an event.
            self.emit(event, user, depending, dependency)
          })
          done()
        })
      })
    },
    callback
  )
}

prototype._semversOf = function (name, callback) {
  var semvers = []
  // Scan keys from `package/semver/` through `package/semver/~`.
  // Keys are URI-encoded ASCII, so `~` is high.
  this._levelup.createReadStream({
    gte: packageKey(name, ''),
    lte: packageKey(name, '~'),
    keys: true,
    values: false
  })
  .on('error', callback)
  .on('data', function (key) {
    semvers.push(semverFromPackageKey(key))
  })
  .on('end', function () {
    callback(null, semvers)
  })
}

prototype._usersBehind = function (name, semver, callback) {
  var key = packageKey(name, semver)
  this._levelup.get(key, function (error, data) {
    if (error) {
      if (error.notFound) callback(null, [])
      else callback(error)
    } else {
      var parsed = JSON.parse(data)
      var users = parsed.contributors
      .concat(parsed.author)
      .filter(isString)
      callback(null, users)
    }
  })
}

var SEQUENCE_KEY = 'sequence'

prototype._setSequence = function (sequence, callback) {
  this._levelup.put(SEQUENCE_KEY, sequence, callback)
}

// Argument Validation

function validUser (argument) {
  return typeof argument === 'string' && argument.length !== 0
}

function validSequence (argument) {
  return Number.isInteger(argument) && argument > 0
}

function isString (argument) {
  return typeof argument === 'string' && argument.length !== 0
}

// LevelUP Helper Functions

function packageKey (name, semver) {
  return encodeLevelUPKey('packages', name, semver)
}

function semverFromPackageKey (key) {
  return decodeLevelUPKey(key)[2]
}

var encode = encodeURIComponent
var decode = decodeURIComponent

function encodeLevelUPKey (/* variadic */) {
  return Array.prototype.slice.call(arguments).map(encode).join('/')
}

function decodeLevelUPKey (key) {
  return key.split('/').map(decode)
}

function putOperation (key, value) {
  return {type: 'put', key: key, value: JSON.stringify(value)}
}
