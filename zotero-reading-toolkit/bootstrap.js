var chromeHandle = null;

function install(data, reason) {}

async function startup({ id, rootURI }, reason) {
  const context = { rootURI };
  context._globalThis = context;

  // Zotero supplies rootURI with a trailing slash. Keep resource URLs canonical:
  // PreferencePanes is stricter about doubled slashes than loadSubScript.
  Services.scriptloader.loadSubScript(`${rootURI}content/core.js`, context);
  Services.scriptloader.loadSubScript(`${rootURI}content/readingToolkit.js`, context);

  Zotero.ReadingTracker = context.ReadingToolkit;

  try {
    const addonManagerStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(`${rootURI}manifest.json`);
    chromeHandle = addonManagerStartup.registerChrome(manifestURI, [
      ["content", "readingtoolkit", `${rootURI}content/`]
    ]);
  }
  catch (error) {
    Zotero.logError(error);
  }

  try {
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: `${rootURI}content/preferences.xhtml`,
      label: "阅读工具箱"
    });
  }
  catch (error) {
    Zotero.logError(error);
  }

  await Zotero.ReadingTracker.startup(id);
}

async function shutdown({ id }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.ReadingTracker?.shutdown();
  delete Zotero.ReadingTracker;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
