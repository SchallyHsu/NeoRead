/* Run this companion on one desktop where both applications are installed. */
var runtime,
  timer,
  busy,
  idle = false;
async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const win = Zotero.getMainWindow();
  const scope = {
    Zotero,
    Services,
    IOUtils,
    PathUtils,
    Cc: Components.classes,
    Ci: Components.interfaces,
    win,
  };
  for (const file of ["model.js", "bridge.js"])
    Services.scriptloader.loadSubScript(rootURI + file, scope);
  runtime = scope.createBridge(rootURI);
  const tick = () => {
    if (idle || busy) return;
    busy = runtime
      .run()
      .catch((e) =>
        Zotero.debug(
          "NeoRead sync: " + e.name + " " + (e.bridgeStage || ""),
          2,
        ),
      )
      .finally(() => {
        busy = null;
      });
  };
  timer = win.setInterval(tick, 120000);
  tick();
}
async function shutdown() {
  idle = true;
  if (timer) Zotero.getMainWindow()?.clearInterval(timer);
  if (runtime) runtime.stop();
  await busy;
}
function install() {}
function uninstall() {}
