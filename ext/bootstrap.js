/* ***** BEGIN LICENSE BLOCK *****
 * Copyright (c) 2011 <dagger.bugzilla+ipvfox@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * ***** END LICENSE BLOCK ***** */

// TODO
//   * Clearing the list when it's open should display a "No hosts yet" message. Maybe use
//     two tables, one with the message and one with the hosts, and hide them appropriately?
//   * Split hosts list into page itself + additional resources
//   * Remove call to updateButtonState() in handleCacheUpdate(). Probably requires the above
//     host list split to work nicely.
//   * Group multiple IPs from the same host together
//   * Downloads cause breakage: they're treated as new page loads, and hang around in the queue
//     until another page is loaded into the tab.

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

const DEBUG = 0;
const LOGALLREQUESTS = 0;

var RHCache = new Array();
var RHWaitingList = new Array();
var RHCallbacks = new Array();

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
             + ", is for download: " + (channel.channelIsForDownload)
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
        logmsg("http-on-examine-response: remote address was not available for load of " + channel.URI.spec + ".");
        return;
      }
      
      if (DEBUG || LOGALLREQUESTS)
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
          
          RHCallbacks.forEach(function (el) el(domWinOuter, newentry));
          
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
          + "window that has already seen content loads. This should never happen; if it does, "
          + "please report it to me, preferably with a way to reproduce. (Note: this "
          + "exception is from IPvFox, regardless of what the Error Console reports.)";
      
      var hosts = RHWaitingList[domWinOuter];
      hosts.unshift(hosts.pop());
      RHCache[domWinInner] = hosts;
      
      /* Notify subscribers. */
      RHCallbacks.forEach(function (el) el(domWinOuter, null));
      hosts.forEach(function (host) {
        RHCallbacks.forEach(function (el) el(domWinOuter, host))
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
  panel.id = "ipvfox-panel";
  if (window.StarUI.panel.getAttribute("type") == "arrow") {
    panel.setAttribute("type", "arrow");
    panel.setAttribute("position", "bottomcenter topright");
  } else {
    panel.removeAttribute("type");
    panel.setAttribute("position", "after_end");
  }
  
  /* Add table to panel. */
  var table = panel.appendChild(window.document.createElementNS("http://www.w3.org/1999/xhtml","html:table"));
  table.id = "ipvfox-table";
  
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
      
      table.setAttribute("ipvfox-nohosts", "true");
    }
    else {
      for (let i = 0; i < hosts.length; i++) {
        addHostRow(hosts[i].host, hosts[i].address);
      }
      
      table.removeAttribute("ipvfox-nohosts");
    }
    
    if (DEBUG) addDebuggingInfo();
    
    /* Subscribe to update notifications. */
    function handleCacheUpdate(updatedOuterID, newentry) {
      if (updatedOuterID != domWinOuter)
        return;
          
      if (newentry == null) {
        /* New page: empty table. */
        while (table.firstChild) table.removeChild(table.firstChild);
        return;
      }
      
      debuglog("Host list update: got new cache entry "
        + newentry.host + "/" + newentry.address);
        
      addHostRow(newentry.host, newentry.address);
    }
    RHCallbacks.push(handleCacheUpdate);
    
    /* Unsubscribe after the panel is closed. */
    panel.addEventListener("popuphiding", function() {
      panel.removeEventListener("popuphiding", arguments.callee, false);
      RHCallbacks = RHCallbacks.filter(function(el) el != handleCacheUpdate);
      panel.hidden = true;
    }, false);
  }, false);
  
  return panel;
}

function insertButton(window, panel) {
  function makeImg(size, which) {
    var img = window.document.createElement('image');
    img.id = "ipvfox-" + size + "-" + which;
    img.setAttribute("src", "resource://ipvfox/res/" + size + "-" + which + ".png");
    return img;
  }
  
  var stack = window.document.createElement('stack');
  var deck = window.document.createElement('deck');
  stack.className = "urlbar-icon";
  stack.appendChild(deck);
  
  stack.MAIN_IPV4       = 0;
  stack.MAIN_IPV6       = 1;
  stack.MAIN_UNKNOWN    = 2;
  stack.ADDITIONAL_IPV4 = stack.appendChild(makeImg("small", "4"));
  stack.ADDITIONAL_IPV6 = stack.appendChild(makeImg("small", "6"));
  
  ["4", "6", "q"].map(function (which) makeImg("big", which))
                 .forEach(function(img) deck.appendChild(img));
  
  /* Functions to control what's visible. */
  stack.setMain = function(which) {
    deck.setAttribute("selectedIndex", which);
  }
  
  stack.setAdditional = function(img, has) {
    if (has)
      img.hidden = false;
    else
      img.hidden = true;
  }
  
  /* Set the default state of the icon. */
  stack.setMain(stack.MAIN_UNKNOWN);
  stack.setAdditional(stack.ADDITIONAL_IPV4, false);
  stack.setAdditional(stack.ADDITIONAL_IPV6, false);
  
  var entrypoint = window.document.getElementById('star-button');
  entrypoint.parentNode.insertBefore(stack, entrypoint);
  
  unload(function() {
    stack.parentNode.removeChild(stack);
  }, window);
  
  /* Add click handler. */
  stack.addEventListener("click", function() {
    panel.hidden = false;
    panel.popupBoxObject.setConsumeRollupEvent(Ci.nsIPopupBoxObject.ROLLUP_CONSUME);
    panel.openPopup(stack, panel.getAttribute("position"), 0, 0, false, false);
  }, false);
  
  return stack;
}

function insertStyleSheet() {
  /* Insert stylesheet */
  var sSS = Cc["@mozilla.org/content/style-sheet-service;1"]
              .getService(Ci.nsIStyleSheetService);
  var IOS = Cc["@mozilla.org/network/io-service;1"]
              .getService(Components.interfaces.nsIIOService);
  var fileURI= IOS.newURI("resource://ipvfox/res/style.css", null, null);
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
    button.setMain(button.MAIN_UNKNOWN);
    button.setAdditional(button.ADDITIONAL_IPV4, false);
    button.setAdditional(button.ADDITIONAL_IPV6, false);
    
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
        //button.setAttribute("ipvfox-ipv4main", "true");
        button.setMain(button.MAIN_IPV4);
      } else {
        //button.setAttribute("ipvfox-ipv6main", "true");
        button.setMain(button.MAIN_IPV6);
      }
    }
    
    var additionalhosts = hosts.slice(hosts[0].wasInitialLoad ? 1 : 0);
    if (additionalhosts.some(function(el) el.address.indexOf(":") == -1)) {
      //button.setAttribute("ipvfox-ipv4additional", "true");
      button.setAdditional(button.ADDITIONAL_IPV4, true);
    }
    if (additionalhosts.some(function(el) el.address.indexOf(":") != -1)) {
      //button.setAttribute("ipvfox-ipv6additional", "true");
      button.setAdditional(button.ADDITIONAL_IPV6, true);
    }
  }
  
  function handleCacheUpdate(updatedOuterID, newentry) {
    debuglog ("Cache update handler for button: Updated ID: " +  updatedOuterID + ", hoping for " + currentTabOuterID);
    debuglog ("By the way, there are " + RHCallbacks.length + " handlers registered.");
    
    if (updatedOuterID != currentTabOuterID)
      return;
      
    if (newentry == null) {
      /* New page: clear image state. */
      button.setMain(button.MAIN_UNKNOWN);
      button.setAdditional(button.ADDITIONAL_IPV4, false);
      button.setAdditional(button.ADDITIONAL_IPV6, false);
      //updateButtonState();
      return;
    }
    
    // TODO: Should throttle updates.
    updateButtonState();
  }
  
  RHCallbacks.push(handleCacheUpdate);
  unload(function() {
    RHCallbacks = RHCallbacks.filter(function(el) el != handleCacheUpdate);
  }, window, true);
  
  window.gBrowser.tabContainer.addEventListener("TabSelect", handler, false);
  unload(function() {
    window.gBrowser.tabContainer.removeEventListener("TabSelect", handler, false);
  }, window);
}

function insertBrowserCode(window) {
  var panel = insertPanel(window);
  var stack = insertButton(window, panel);
  
  addTabSelectHandler(window, stack);
  
  insertStyleSheet();
}

function logmsg(aMessage) {
  var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
                                 .getService(Components.interfaces.nsIConsoleService);
  consoleService.logStringMessage("IPvFox: " + aMessage);
}

function debuglog(aMessage) {
  if (!DEBUG) return;
  
  var consoleService = Components.classes["@mozilla.org/consoleservice;1"]
                                 .getService(Components.interfaces.nsIConsoleService);
  consoleService.logStringMessage("IPvFox: " + aMessage);
}


function watchWindows(callback) {
  // This function originally wrapped callback() in a try/catch block
  // to supress errors, but it's more useful if those errors are
  // actually reported rather than silently eaten.
  function watcher(window) {
    // Now that the window has loaded, only handle browser windows
    let {documentElement} = window.document;
    if (documentElement.getAttribute("windowtype") == "navigator:browser"
        || documentElement.getAttribute("windowtype") == "mail:3pane")
      callback(window);
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
  
  // This function originally wrapped callback() in a try/catch block
  // to supress errors, but it's more useful if those errors are
  // actually reported rather than silently eaten.
  function unloader() {
    callback();
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
  resource.setSubstitution("ipvfox", alias);
  
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
    resource.setSubstitution("ipvfox", null);
    
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
