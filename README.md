```javascript
var Intervention = require('intervention')
var memdb = require('memdb')

var emitter = new Intervention(memdb())
// Emit events for new deps.
.emitEventsFor('author@example.com')
// Emit events...
.emitEventsFor(
  'another@example.com',
  // for devDeps as well as deps...
  true,
  // from update 458344.
  458344
)
.on('dependency', function (person, depending, dependency) {
  console.log(
    '%s depends on %s\'s %s',
    depending.name, person, dependency.name
  )
})
.on('devDependency', function (person, depending, dependency) {
  console.log(
    '%s depends on %s\'s %s',
    depending.name, person, dependency.name
  )
})
emitter.start()
```
