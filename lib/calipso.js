/*!
 * Calipso Core Library
 *
 * Copyright(c) 2011 Clifton Cunningham <clifton.cunningham@gmail.com>
 * MIT Licensed
 *
 * This is the core Calipso middleware that controls the bootstrapping, and core routing functions, required for
 * Calipso to function.  This is loaded into an Express application via:
 *
 *     app.use(calipso.calipsoRouter(next);
 *
 * Further detail is contained in comments for each function and object.
 *
 */

/**
 * Module exports
 *
 *     lib : Libraries that can be re-used in each module (avoids repetition), imported lib or utils (not core lib)
 *     sessionCache : Holds cache of logged in users.
 *     dynamicHelpers : Helper functions that can be used in views (e.g. getBlock etc.)
 *     getDynamicHelpers : Function that loads Dynamic helpers (TODO : refactor into single function)
 *     mr : Tracks running map reduce operations, to ensure that multiple updates do not conflict.
 *     theme : Link to the currently loaded theme (one per site).
 *     data : In memory store of common data (e.g. allows caching vs repetitive returns to mongo)
 *     modules : Object that holds all loaded modules, modules are properties based on their name.
 *     date : shortcut to Calipso date library (link below)
 *     form : shortcut to Calipso form library (link below)
 *
 */

var rootpath = process.cwd() + '/',
    path = require('path'),
    fs = require('fs'),
    events = require('events');

// Core object
var calipso = module.exports = {

  // View Helpers
  getDynamicHelpers: function(req, res) {
    req.helpers = {};
    for(var helper in this.helpers) {
      req.helpers[helper] = this.helpers[helper](req, res, this);
    }
  },
  
  // Configuration exposed
  reloadConfig: reloadConfig,
  
  // Core objects - themes, data, modules
  theme: {},
  data: {},
  modules: {},

  // Express Router
  calipsoRouter: router

};

// Load libraries in the core folder
loadCore(calipso);

function loadCore(calipso) {

    fs.readdirSync(rootpath + 'lib/core').forEach(function(library){ 
        var libName = library.split(".")[0].toLowerCase();
        calipso[libName] = require(rootpath + 'lib/core/' + library);
    });

}

/**
 * Core router and initialisation function.
 *
 * Returns a connect middleware function that manages the roucting
 * of requests to modules.
 */
function router(app, initCallback) {

  calipso.app = app;
  
  // Load the calipso package.json into about
  calipso.module.loadAbout(app, rootpath, 'package.json');

  calipso.config = app.config;

  // Configure the cache
  calipso.cacheService = calipso.cache.Cache({ttl:calipso.config.get('performance:cache:ttl')});

  // Store the callback function for later
  calipso.initCallback = function() {
    initCallback();
  };

  // Create our calipso event emitter
  calipso.e = new calipso.event.CalipsoEventEmitter();

  // Load configuration
  initialiseCalipso();

  // Return the function that manages the routing
  // Ok being non-synchro
  return function(req,res,next) {

    // Default menus and blocks for each request
    // More of these can be added in modules, these are jsut the defaults
    res.menu = {admin:new calipso.menu.CalipsoMenu('admin','weight','root',{cls:'admin'}),
                adminToolbar:new calipso.menu.CalipsoMenu('adminToolbar','weight','root',{cls:'admin-toolbar toolbar'}), // TODO - Configurable!
                userToolbar:new calipso.menu.CalipsoMenu('userToolbar','weight','root',{cls:'user-toolbar toolbar'}),
                primary:new calipso.menu.CalipsoMenu('primary','name','root',{cls:'primary'}),
                secondary:new calipso.menu.CalipsoMenu('secondary','name','root',{cls:'secondary'})};


    // Initialise our clientJS library linked to this request
    var Client = require('./client/Client');
    res.client = new Client();

    // Initialise helpers - first pass
    calipso.getDynamicHelpers(req, res);

    // Deal with any form content
    // This is due to node-formidable / connect / express
    // https://github.com/felixge/node-formidable/issues/30
    // Best to parse the form very early in the chain
    if(req.form) {

      calipso.form.process(req, function() {

        // Route the modules
        calipso.module.eventRouteModules(req, res, next);

      });

    } else {

      // Route the modules
      calipso.module.eventRouteModules(req, res, next);

    }

  };
}

/**
 * Load the application configuration
 * Configure the logging
 * Configure the theme
 * Load the modules
 * Initialise the modules
 *
 * @argument config
 *
 */
function initialiseCalipso(reloadConfig) {

  // Check if we need to reload the config from disk (e.g. from cluster mode)
  if(reloadConfig) {
    calipso.config.load();
  }

  // Clear Event listeners
  calipso.e.init();

  // Configure the logging
  calipso.logging.configureLogging();

  // Check / Connect Mongo
  calipso.storage.mongoConnect(calipso.config.get('database:uri'), false, function(err, connected) {

     if(err) {
       console.log("There was an error connecting to the database: " + err.message);
       process.exit();
     }

    // Load all the themes
    loadThemes(function() {

      // Initialise the modules and  theming engine
      configureTheme(function() {

        // Load all the modules
        calipso.module.loadModules(function() {

          // Initialise, callback via calipso.initCallback
          calipso.module.initModules();
          
        });

      });

    });

  });

}

/**
* Called both via a hook.io event as
* well as via the server that initiated it.
*/
function reloadConfig(event, data, next) {

    // Create a callback
    calipso.initCallback = function (err) {
      // If called via event emitter rather than hook
      if(typeof next === "function") next(err);
    }
    return initialiseCalipso(true);

}

/**
 * Load the available themes into the calipso.themes object
 */
function loadThemes(next) {

  // Load the available themes
  calipso.availableThemes = calipso.availableThemes || {};

  var themeBasePath = calipso.config.get('server:themePath');

  calipso.lib.fs.readdirSync(calipso.lib.path.join(calipso.app.path,themeBasePath)).forEach(function(folder){

    if(folder != "README" && folder != '.DS_Store') {

        var themes = calipso.lib.fs.readdirSync(calipso.lib.path.join(calipso.app.path,themeBasePath,folder));

        // First scan for legacy themes
        var legacyTheme = false;
        themes.forEach(function(theme) {
            if(theme === "theme.json") {
              legacyTheme = true;
              console.log("Themes are now stored in sub-folders under the themes folder, please move: " + folder + " (e.g. to custom/" + folder + ").\r\n");
            }
        });

        // Process
        if(!legacyTheme) {
          themes.forEach(function(theme) {

            if(theme != "README" && theme != '.DS_Store')
              var themePath = calipso.lib.path.join(calipso.app.path,themeBasePath,folder,theme);
            // Create the theme object
              calipso.availableThemes[theme] = {
                name: theme,
                path: themePath
              };
              // Load the about info from package.json
              calipso.module.loadAbout(calipso.availableThemes[theme], themePath, 'theme.json');
          });
        }
      }
   });


  next();


}

/**
 * Configure a theme using the theme library.
 */
function configureTheme(next, overrideTheme) {

  var defaultTheme = calipso.config.get("theme:default");
  var themeName = overrideTheme ? overrideTheme : calipso.config.get('theme:front');
  var themeConfig = calipso.availableThemes[themeName]; // Reference to theme.json

  if(themeConfig) {

    // Themes is the library
    calipso.themes.Theme(themeConfig, function(err, loadedTheme) {

      // Current theme is always in calipso.theme
      calipso.theme = loadedTheme;

      if(err) {
        calipso.error(err.message);
      }

      if (!calipso.theme) {

        if(loadedTheme.name === defaultTheme) {
           calipso.error('There has been a failure loading the default theme, calipso cannot start until this is fixed, terminating.');
           process.exit();
           return;
        } else {
          calipso.error('The `' + themeName + '` theme failed to load, attempting to use the default theme: `' + defaultTheme + '`');
          configureTheme(next, defaultTheme);
          return;
        }

      } else {

        // Search for middleware that already has themeStatic tag
        var foundMiddleware = false,mw;
        calipso.app.stack.forEach(function(middleware,key) {

         if(middleware.handle.tag === 'theme.stylus') {
           foundMiddleware = true;
           mw = calipso.app.mwHelpers.stylusMiddleware(themeConfig.path);
           calipso.app.stack[key].handle = mw;
         }

         if(middleware.handle.tag === 'theme.static') {
           foundMiddleware = true;
           mw = calipso.app.mwHelpers.staticMiddleware(themeConfig.path);
           calipso.app.stack[key].handle = mw;
         }

        });

        next();

      }

    });

  } else {

    if(themeName ===  defaultTheme) {
      calipso.error("Unable to locate the theme: " + themeName + ", terminating.");
      process.exit();
    } else {
      calipso.error('The `' + themeName + '` theme is missing, trying the defaul theme: `' + defaultTheme + '`');
      configureTheme(next, defaultTheme);
    }

  }

} 

