'use strict';

// Mounts all route modules onto an express app. Each child module exports
// a factory `(deps) => router`. The index just composes them in order.
function mountAll(app, deps) {
  app.use(require('./status')(deps));
  app.use(require('./settings')(deps));
  app.use(require('./noten')(deps));
  app.use(require('./stundenplan')(deps));
  app.use(require('./db')(deps));
  app.use(require('./absenzen')(deps));
  app.use(require('./stats')(deps));
  app.use(require('./scrape')(deps));
  app.use(require('./push')(deps));
  app.use(require('./logs')(deps));
  app.use(require('./events')(deps));
}

module.exports = { mountAll };
