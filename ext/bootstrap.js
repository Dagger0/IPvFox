// TODO
//   * Style and icon fixes
//   * Split hosts list into page itself + additional resources?

/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Restartless.
 *
 * The Initial Developer of the Original Code is The Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Edward Lee <edilee@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

const DEBUG = 0;
const LOGALLREQUESTS = 0;

var RHCache = new Array();
var RHWaitingList = new Array();
var RHTest = new Array();

var httpRequestObserver =
{
  observe: function(subject, topic, data) {
    function showDebugInfo() {
      if (!DEBUG) return;
      debuglog("Flags: " + channel.loadFlags 
             + " (has LOAD_DOCUMENT_URI: " + (channel.loadFlags & Ci.nsIChannel.LOAD_DOCUMENT_URI)
             + ", LOAD_INITIAL_DOCUMENT_URI: " + (channel.loadFlags & Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI)
             + "), top window: " + (originalWin == originalWin.top) 
             + ", is redirect: " + (channel.URI.spec != channel.originalURI.spec)
             + ", loadGroup: " + (channel.loadGroup) 
             + ", groupObserver: " + (channel.loadGroup && channel.loadGroup.groupObserver)
             + ", owner: " + (channel.owner)
             + ", windows: " + domWinInner + " (inner) " + domWinOuter + " (outer)"
             );
    }
    
    if (topic == "http-on-examine-response") {
      var channel = subject;
      
      channel.QueryInterface(Components.interfaces.nsIHttpChannel);
      channel.QueryInterface(Components.interfaces.nsIHttpChannelInternal);
      
      /* remoteAddress is randomly not available sometimes. 
         Check, and mention on the console if it's not. */
      try {
        channel.remoteAddress;
      } catch (ex) {
        logmsg("http-on-examine-respose: remote address was not available for load of " + channel.URI.spec + ".");
        return;
      }

      if (LOGALLREQUESTS)
        logmsg("http-on-examine-response: Loading " + channel.URI.spec + " (" + channel.remoteAddress + ")");
      
      /* Fetch DOM window */
      var nC = channel.notificationCallbacks;
      if (!nC) nC = channel.loadGroup.notificationCallbacks;
      if (!nC) {
        debuglog ("http-on-examine-response: Failed to obtain notificationCallbacks: no way to find out who initiated this load.");
        return;
      }
      
      try {
        var domWin      = nC.getInterface(Components.interfaces.nsIDOMWindow).top;
        var domWinUtils = domWin
                            .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                            .getInterface(Components.interfaces.nsIDOMWindowUtils);
        var domWinInner = domWinUtils.currentInnerWindowID;
        var domWinOuter = domWinUtils.outerWindowID;
  
        var originalWin = nC.getInterface(Components.interfaces.nsIDOMWindow);
      } catch(ex) { /* Load is from non-DOM source -- RSS feeds, EM etc */
        return;
      }
      
      showDebugInfo();

      /* Detect new page loads. These happen before their own DOM is created, so
         they have domWinInner = the previous document loaded in the tab. */
      if (channel.loadFlags & Ci.nsIChannel.LOAD_INITIAL_DOCUMENT_URI)
        if (originalWin == originalWin.top)
          var isNewPage = true;

      /* Create host entry. */
      var newentry = { 
        host: channel.URI.prePath, 
        address: channel.remoteAddress,
        wasInitialLoad: isNewPage,
      }

      if (isNewPage) {
        /* New page load: inner window id will be wrong. Wait around until we get a
           content-document-global-created for the same outer window, which will
           have the new inner window id. */
        if (DEBUG) newentry.address += "-nl";
          
        var hosts = new Array();
        if (RHWaitingList[domWinOuter])
          hosts = RHWaitingList[domWinOuter];
          
        if (!hosts.some(function(r) r.host == newentry.host && r.address == newentry.address)) {
          hosts.push(newentry);
          RHWaitingList[domWinOuter] = hosts;
        }
      RHTest.forEach(function (el) el(domWinOuter, null));

        debuglog("http-on-examine-response: New page load; queuing host info for " +
          " outer window " + domWinOuter + " (current inner window is " + 
          domWinInner + " containing " + domWin.location + ")");
      } else {
        /* Not new load (CSS, image, etc): inner window id is right. */
        var hosts = new Array();
        if (RHCache[domWinInner])
          hosts = RHCache[domWinInner];

        if (!hosts.some(function(r) r.host == newentry.host && r.address == newentry.address)) {
          hosts.push(newentry);
          RHCache[domWinInner] = hosts;
          
          RHTest.forEach(function (el) el(domWinOuter, newentry));

          debuglog("http-on-examine-response: additional load; attached host info to inner window " + domWinInner + " which is " + domWin.location);
        }
        
      }
    }

    else if (topic == "content-document-global-created") {
      var domWin = subject;
      var domWinUtils = domWin.top
                          .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                          .getInterface(Components.interfaces.nsIDOMWindowUtils);
      var domWinInner = domWinUtils.currentInnerWindowID;
      var domWinOuter = domWinUtils.outerWindowID;
      
      debuglog("content-document-global-created: window IDs: " 
        + domWinInner + " (inner) "
        + domWinOuter + " (outer), "
        + "location: " + domWin.location);
        
      if (!RHWaitingList[domWinOuter]) 
        return;
      
      debuglog("content-document-global-created: "
        + "waiting list: " + RHWaitingList[domWinOuter].length);

      if (RHCache[domWinInner])
        throw "content-document-global-created: this notification is for an inner DOM "
          + "window that has already seen content loads. This should never happen; please"
          + "report it to me if it does.";

      var hosts = RHWaitingList[domWinOuter];
      hosts.unshift(hosts.pop());
      RHCache[domWinInner] = hosts;             
      
      /* Notify subscribers. */
      RHTest.forEach(function (el) el(domWinOuter, null));
      hosts.forEach(function (host) {
        RHTest.forEach(function (el) el(domWinOuter, host))
      });
      
      delete RHWaitingList[domWinOuter];
    }
    
    else if (topic == "inner-window-destroyed") {
      var domWinInner = subject.QueryInterface(Components.interfaces.nsISupportsPRUint64)
                               .data;
      
      delete RHCache[domWinInner];
      debuglog("inner-window-destroyed: " + domWinInner);
    }
    
    else if (topic == "outer-window-destroyed") {
      var domWinOuter = subject.QueryInterface(Components.interfaces.nsISupportsPRUint64)
                               .data;
                               
      delete RHWaitingList[domWinOuter];
      debuglog("outer-window-destroyed: " + domWinOuter);
    }
  },

  get observerService() {
    return Components.classes["@mozilla.org/observer-service;1"]
                     .getService(Components.interfaces.nsIObserverService);
  },

  register: function() {
    this.observerService.addObserver(this, "http-on-examine-response", false);
    this.observerService.addObserver(this, "content-document-global-created", false);
    this.observerService.addObserver(this, "inner-window-destroyed", false);
    this.observerService.addObserver(this, "outer-window-destroyed", false);
  },

  unregister: function() {
    this.observerService.removeObserver(this, "http-on-examine-response");
    this.observerService.removeObserver(this, "content-document-global-created");
    this.observerService.removeObserver(this, "inner-window-destroyed");
    this.observerService.removeObserver(this, "outer-window-destroyed");
  }
};

function insertPanel(window) {
  /* The panel itself. */
  var panel = window.document.createElement('panel');
  panel.id = "ipvfoo-panel";
  if (window.StarUI.panel.getAttribute("type") == "arrow") {
    panel.setAttribute("type", "arrow");
    panel.setAttribute("position", "bottomcenter topright");
  } else {
    panel.removeAttribute("type");
    panel.setAttribute("position", "after_end");
  }
  
  /* Add table to panel. */
  var table = panel.appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:table"));
  table.id = "ipvfoo-table";
  
  /* Bugfix: panel shows previous contents briefly unless it's hidden when hidden. */
  panel.hidden = true;

  /* Bugfix: the panel needs to have content initially, otherwise the arrow shows up 
     in the upper-left rather than the upper-right the first time it is shown. */
  table.appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:tr"))
       .appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td"))
       .appendChild(window.document.createTextNode("Temp node to force the panel to have some initial width."));
  
  /* Add panel to browser. */
  var entrypoint = window.document.getElementById('mainPopupSet');
  entrypoint.appendChild(panel, entrypoint);
  
  unload(function() {
    panel.parentNode.removeChild(panel);
  }, window);

  /* Fill out the table when popup is shown. */
  panel.addEventListener("popupshowing", function() {
    function addHostRow(hostname, address) {
      var row   = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:tr");
      var cell1 = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td");
      var cell2 = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td");
     
      cell1.appendChild(window.document.createTextNode(hostname));
      cell2.appendChild(window.document.createTextNode(address));

      if (address.indexOf(":") != -1)
        cell2.className = "ipv6";
      else
        cell2.className = "ipv4";

      row.appendChild(cell1);
      row.appendChild(cell2);
      table.appendChild(row);
    }
    
    function addDebuggingInfo() {
      function addRow(content) {
        var cell = table.appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:tr"))
                        .appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td"));                
        cell.appendChild(window.document.createTextNode(content));
        cell.setAttribute("colspan", "2");
      }
      
      addRow("Inner window: " + domWinInner);
      addRow("Outer window: " + domWinOuter);
    }
    
    var domWin = window.gBrowser.mCurrentBrowser.contentWindow;
    var domWinUtils = domWin.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                            .getInterface(Components.interfaces.nsIDOMWindowUtils);
    var domWinInner = domWinUtils.currentInnerWindowID;
    var domWinOuter = domWinUtils.outerWindowID;
    
    var hosts = RHCache[domWinInner];

    while (table.firstChild) table.removeChild(table.firstChild);

    if (typeof(hosts) === 'undefined') {
      var cell = table.appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:tr"))
                      .appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td"));
      cell.appendChild(window.document.createTextNode("No hosts seen yet."));
      cell.setAttribute("colspan", "2");

      table.setAttribute("ipvfoo-nohosts", "true");
    } 
    else {
      for (let i = 0; i < hosts.length; i++) {
        addHostRow(hosts[i].host, hosts[i].address);
      }
      
      table.removeAttribute("ipvfoo-nohosts");
    }
    
    if (DEBUG) addDebuggingInfo();
    
    /* Subscribe to update notifications. */
    function handleCacheUpdate(updatedOuterID, newentry) {
      if (updatedOuterID != domWinOuter)
        return;
          
      if (updatedOuterID == newentry) {
        /* New page: empty table. */
        while (table.firstChild) table.removeChild(table.firstChild);
        return;
      }
      
      debuglog("Host list update: got new cache entry " 
        + newentry.host + "/" + newentry.address);
        
      addHostRow(newentry.host, newentry.address);
    }
    RHTest.push(handleCacheUpdate);

    /* Unsubscribe after the panel is closed. */
    panel.addEventListener("popuphiding", function() {
      panel.removeEventListener("popuphiding", arguments.callee);
      RHTest = RHTest.filter(function(el) el != handleCacheUpdate);
      panel.hidden = true;
    });
  });
  
  return panel;
}

function insertButton(window, panel) {
  /* Insert URL bar icon to bring up the panel. */
  var img = window.document.createElement('image');
  img.id = "go-button";
  img.className = "urlbar-icon";
  img.addEventListener("click", function() {
    panel.hidden = false;
    panel.popupBoxObject.setConsumeRollupEvent(Ci.nsIPopupBoxObject.ROLLUP_CONSUME);
    panel.openPopup(img, panel.getAttribute("position"), 0, 0, false, false);
  });
  var entrypoint = window.document.getElementById('go-button');
  entrypoint.parentNode.insertBefore(img, entrypoint);

  unload(function() {
    img.parentNode.removeChild(img);
  }, window);
  return img;
}

function insertStyleSheet() {
  /* Insert stylesheet */
  var sSS = Cc["@mozilla.org/content/style-sheet-service;1"]
              .getService(Ci.nsIStyleSheetService);
  var IOS = Cc["@mozilla.org/network/io-service;1"]
              .getService(Components.interfaces.nsIIOService);              
  var fileURI= IOS.newURI("resource://ipvfoo/style.css", null, null);
  sSS.loadAndRegisterSheet(fileURI, sSS.AGENT_SHEET);
  unload(function() sSS.unregisterSheet(fileURI, sSS.AGENT_SHEET));
}

function addTabSelectHandler(window, button) {
  var currentTabOuterID;
  var domWinUtils;
    
  function handler(evt) {
    debuglog("TabSelect handler: running")
    /* Fetch a nsIDomWindowUtils. */
    var domWin  = window.gBrowser.mCurrentBrowser.contentWindow;
    domWinUtils = domWin.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                        .getInterface(Components.interfaces.nsIDOMWindowUtils);

    /* Tab was changed, so clear the current state. */
    button.removeAttribute("ipvfoo-ipv4main");
    button.removeAttribute("ipvfoo-ipv6main");
    button.removeAttribute("ipvfoo-ipv4additional");
    button.removeAttribute("ipvfoo-ipv6additional");
    
    /* Add state for the new tab. */
    updateButtonState();
    
    /* Store the outer ID. Whenever the cache changes, handleCacheUpdate() is
       called with the relevent outer ID, which is then compares with this one. */
    currentTabOuterID = domWinUtils.outerWindowID;
    debuglog ("TabSelect handler: set current outer window ID to " + domWinUtils.outerWindowID);
  }

  function updateButtonState() {
    var hosts = RHCache[domWinUtils.currentInnerWindowID];
  
    if (typeof(hosts) === 'undefined')
      return;
    
    /* The first entry is handled differently if it was an initial load: this is the
     * page itself rather than one of its resources. */
    if (hosts[0].wasInitialLoad) {
      if (hosts[0].address.indexOf(":") == -1) {
        button.setAttribute("ipvfoo-ipv4main", "true");
      } else {
        button.setAttribute("ipvfoo-ipv6main", "true");
      }
    }
    
    var additionalhosts = hosts.slice(hosts[0].wasInitialLoad ? 1 : 0);
    if (additionalhosts.some(function(el) el.address.indexOf(":") == -1))
      button.setAttribute("ipvfoo-ipv4additional", "true");
    if (additionalhosts.some(function(el) el.address.indexOf(":") != -1))
      button.setAttribute("ipvfoo-ipv6additional", "true");
  }
  
  function handleCacheUpdate(updatedOuterID, newentry) {
    debuglog ("Cache update handler for button: Updated ID: " +  updatedOuterID + ", hoping for " + currentTabOuterID);
    debuglog ("By the way, there are " + RHTest.length + " handlers registered.");
    
    if (updatedOuterID != currentTabOuterID)
      return;
      
    if (newentry == null) {
      /* New page: clear image state. */
      button.removeAttribute("ipvfoo-ipv4main");
      button.removeAttribute("ipvfoo-ipv6main");
      button.removeAttribute("ipvfoo-ipv4additional");
      button.removeAttribute("ipvfoo-ipv6additional");
      updateButtonState();
      return;
    }
    
    // TODO: Should throttle updates.
    updateButtonState();
  }

  RHTest.push(handleCacheUpdate);
  unload(function() {
    RHTest = RHTest.filter(function(el) el != handleCacheUpdate);
  }, window, true);

  window.gBrowser.tabContainer.addEventListener("TabSelect", handler, false);
  unload(function() {
    window.gBrowser.tabContainer.removeEventListener("TabSelect", handler, false);
  }, window);
}

function insertBrowserCode(window) {
  var panel = insertPanel(window);
  var button = insertButton(window, panel);
  
  addTabSelectHandler(window, button);

  insertStyleSheet();
}

function logmsg(aMessage) {
  var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
                                 .getService(Components.interfaces.nsIConsoleService);
  consoleService.logStringMessage("HTTP request: " + aMessage);
}

function debuglog(aMessage) {
  if (!DEBUG) return;
  
  var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
                                 .getService(Components.interfaces.nsIConsoleService);
  consoleService.logStringMessage("HTTP request: " + aMessage);
}


function watchWindows(callback) {
  // Wrap the callback in a function that ignores failures
  function watcher(window) {
    //try {
      // Now that the window has loaded, only handle browser windows
      let {documentElement} = window.document;
      if (documentElement.getAttribute("windowtype") == "navigator:browser"
          || documentElement.getAttribute("windowtype") == "mail:3pane")
        callback(window);
    //}
    //catch(ex) {}
  }

  // Wait for the window to finish loading before running the callback
  function runOnLoad(window) {
    // Listen for one load event before checking the window type
    window.addEventListener("load", function runOnce() {
      window.removeEventListener("load", runOnce, false);
      watcher(window);
    }, false);
  }

  // Add functionality to existing windows
  let windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    // Only run the watcher immediately if the window is completely loaded
    let window = windows.getNext();
    if (window.document.readyState == "complete")
      watcher(window);
    // Wait for the window to load before continuing
    else
      runOnLoad(window);
  }

  // Watch for new browser windows opening then wait for it to load
  function windowWatcher(subject, topic) {
    if (topic == "domwindowopened")
      runOnLoad(subject);
  }
  Services.ww.registerNotification(windowWatcher);

  // Make sure to stop watching for windows if we're unloading
  unload(function() Services.ww.unregisterNotification(windowWatcher));
}

/**
 * Save callbacks to run when unloading. Optionally scope the callback to a
 * container, e.g., window. Provide a way to run all the callbacks.
 *
 * @usage unload(): Run all callbacks and release them.
 *
 * @usage unload(callback): Add a callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @return [function]: A 0-parameter function that undoes adding the callback.
 *
 * @usage unload(callback, container) Add a scoped callback to run on unload.
 * @param [function] callback: 0-parameter function to call on unload.
 * @param [node] container: Remove the callback when this container unloads.
 * @return [function]: A 0-parameter function that undoes adding the callback.
 */
function unload(callback, container, callanyway) {
  // Initialize the array of unloaders on the first usage
  let unloaders = unload.unloaders;
  if (unloaders == null)
    unloaders = unload.unloaders = [];

  // Calling with no arguments runs all the unloader callbacks
  if (callback == null) {
    unloaders.slice().forEach(function(unloader) unloader());
    unloaders.length = 0;
    return;
  }

  // The callback is bound to the lifetime of the container if we have one
  if (container != null) {
    // Remove the unloader when the container unloads
    container.addEventListener("unload", removeUnloader, false);

    // Wrap the callback to additionally remove the unload listener
    let origCallback = callback;
    callback = function() {
      container.removeEventListener("unload", removeUnloader, false);
      origCallback();
    }
  }

  // Wrap the callback in a function that ignores failures
  function unloader() {
//    try {
      callback();
//    }
//    catch(ex) {}
  }
  unloaders.push(unloader);

  // Provide a way to remove the unloader
  function removeUnloader() {
    // If callanyway = true, call the unloader even though the thing it works on
    // is going away.
    if (callanyway) unloader();
    let index = unloaders.indexOf(unloader);
    if (index != -1)
      unloaders.splice(index, 1);
  }
  return removeUnloader;
}

/**
 * Handle the add-on being activated on install/enable
 */
function startup(data, reason) {
  /* Register our resource:// URL.
   * http://starkravingfinkle.org/blog/2011/01/restartless-add-ons-more-resources/ */
  var resource = Services.io.getProtocolHandler("resource")
                            .QueryInterface(Ci.nsIResProtocolHandler);
  var alias = Services.io.newFileURI(data.installPath);
  if (!data.installPath.isDirectory())
    alias = Services.io.newURI("jar:" + alias.spec + "!/", null, null);
  resource.setSubstitution("ipvfoo", alias);

  /* Register HTTP observer, add per-window code. */
  httpRequestObserver.register();
  watchWindows(insertBrowserCode);
  debuglog("Registered.");
}

/**
 * Handle the add-on being deactivated on uninstall/disable
 */
function shutdown(data, reason) {
  // Clean up with unloaders when we're deactivating
  if (reason != APP_SHUTDOWN) {
    var resource = Services.io.getProtocolHandler("resource")
                              .QueryInterface(Ci.nsIResProtocolHandler);
    resource.setSubstitution("ipvfoo", null);

    httpRequestObserver.unregister();
    unload();
  }
}

/**
 * Handle the add-on being installed
 */
function install(data, reason) {}

/**
 * Handle the add-on being uninstalled
 */
function uninstall(data, reason) {}
