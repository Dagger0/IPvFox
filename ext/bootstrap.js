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
//   * Group multiple IPs from the same host together
//   * Downloads cause breakage: they're treated as new page loads, and hang around in the queue
//     until another page is loaded into the tab.

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

function _(msg, ...args) {
  if (!this._bundle) this._bundle = Services.strings.createBundle("chrome://ipvfox/locale/ipvfox.properties");
  if (args.length == 0) return this._bundle.GetStringFromName(msg);
  else return this._bundle.formatStringFromName(msg, args, args.length)
}

const DEBUG = 0;
const LOGALLREQUESTS = 0;

const AF_UNSPEC = 0;
const AF_INET = 2;
const AF_INET6 = 23;

var RHCache = new Array();
var RHWaitingList = new Array();
var RHCallbacks = new Array();

var httpRequestObserver =
{
  observe: function(subject, topic, data) {
    function showDebugInfo() {
      if (!DEBUG) return;

      var nC2 = channel.loadGroup.notificationCallbacks;
      var domWin2      = nC2.getInterface(Ci.nsIDOMWindow);
      var domWinUtils2 = domWin2.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIDOMWindowUtils);
      var domWinInner2 = domWinUtils2.currentInnerWindowID;
      var domWinOuter2 = domWinUtils2.outerWindowID;

      var nC3 = channel.notificationCallbacks;
      var domWin3      = nC3.getInterface(Ci.nsIDOMWindow);
      var domWinUtils3 = domWin3.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIDOMWindowUtils);
      var domWinInner3 = domWinUtils3.currentInnerWindowID;
      var domWinOuter3 = domWinUtils3.outerWindowID;

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
             + ", direct windows: " + domWinInner3 + " (inner) " + domWinOuter3 + " (outer)"
             + ", direct loadGroup windows: " + domWinInner2 + " (inner) " + domWinOuter2 + " (outer)"
             );
    }
    
    if (topic == "http-on-examine-response") {
      var channel = subject;
      
      channel.QueryInterface(Ci.nsIHttpChannel);
      channel.QueryInterface(Ci.nsIHttpChannelInternal);
      
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
        var domWin      = nC.getInterface(Ci.nsIDOMWindow).top;
        var domWinUtils = domWin.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIDOMWindowUtils);
        var domWinInner = domWinUtils.currentInnerWindowID;
        var domWinOuter = domWinUtils.outerWindowID;
        
        var originalWin = nC.getInterface(Ci.nsIDOMWindow);
      } catch(ex) { /* Load is from non-DOM source -- RSS feeds, EM etc */
        if (DEBUG) throw (ex);
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
        isMainHost: false,
        family: (channel.remoteAddress.indexOf(":") == -1 ? AF_INET : AF_INET6),
      }
      
      /* If the address matches ::xxxx:xxxx, convert it to ::nnn.nnn.nnn.nnn format. */
      if (Preferences.get("extensions.ipvfox.detectEmbeddedv4")) {
        if (matches = newentry.address.match(/^([0-9a-f:]+?)::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)) {
          function zeroPad(num,count) {
            var numZeropad = num + '';
            while(numZeropad.length < count) {
              numZeropad = "0" + numZeropad;
            }
            return numZeropad;
          };
          
          var p1 = zeroPad(matches[2], 4);
          var p2 = zeroPad(matches[3], 4);
          
          var o1 = parseInt(p1.substr(0,2),16).toString(10);
          var o2 = parseInt(p1.substr(2,2),16).toString(10);
          var o3 = parseInt(p2.substr(0,2),16).toString(10);
          var o4 = parseInt(p2.substr(2,2),16).toString(10);
          
          if (o1 != 0) { // Don't convert if the first octet would be 0.
            var v4 = o1 + "." + o2 + "." + o3 + "." + o4;
            newentry.address = matches[1] + "::" + v4;
          }
        };
      };
      
      /* If the address matches one of the configured NAT64 prefixes, set the family to v4. */
      if (NAT64.isNAT64Address(newentry.address))
        newentry.family = AF_INET;
      
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
                              .QueryInterface(Ci.nsIInterfaceRequestor)
                              .getInterface(Ci.nsIDOMWindowUtils);
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
      hosts[0].isMainHost = true;
      RHCache[domWinInner] = hosts;
      
      /* Notify subscribers. */
      RHCallbacks.forEach(function (el) el(domWinOuter, null));
      hosts.forEach(function (host) {
        RHCallbacks.forEach(function (el) el(domWinOuter, host))
      });
      
      delete RHWaitingList[domWinOuter];
    }
    
    else if (topic == "inner-window-destroyed") {
      var domWinInner = subject.QueryInterface(Ci.nsISupportsPRUint64)
                               .data;
      
      delete RHCache[domWinInner];
      debuglog("inner-window-destroyed: " + domWinInner);
    }
    
    else if (topic == "outer-window-destroyed") {
      var domWinOuter = subject.QueryInterface(Ci.nsISupportsPRUint64)
                               .data;
      
      delete RHWaitingList[domWinOuter];
      debuglog("outer-window-destroyed: " + domWinOuter);
    }

    else if (topic == "addon-options-displayed") {
      if (data == "ipvfox@dagger2-addons.mozilla.org") {
        var doc = subject;

        var node = doc.getElementById('ipvfox_nat64autodetect');
        if (!node) return;

        var desc = doc.createElement("description");
        desc.setAttribute("flex", "1");
        desc.textContent = _("Unknown");

        var button = doc.createElement("button");
        button.setAttribute("label", _("Refresh"));

        node.appendChild(desc);
        node.appendChild(button);

        function updateText(prefixes) {
          if (prefixes && prefixes.length > 0)
            desc.textContent = prefixes.join(", ");
          else if (prefixes)
            desc.textContent = _("None");
          else if (NAT64.detectAttempts > 0)
            desc.textContent = _("Error resolving", "ipv4only.arpa");
          else
            desc.textContent = _("No attempt made");
        }
        updateText(NAT64.detectedPrefixes);

        button.addEventListener("command", function resolveListener() {
          desc.textContent = _("Resolving...");
          NAT64.detect(updateText);
        });
      }
    }
  },
  
  register: function() {
    Services.obs.addObserver(this, "http-on-examine-response", false);
    Services.obs.addObserver(this, "content-document-global-created", false);
    Services.obs.addObserver(this, "inner-window-destroyed", false);
    Services.obs.addObserver(this, "outer-window-destroyed", false);
    Services.obs.addObserver(this, "addon-options-displayed", false);
  },
  
  unregister: function() {
    Services.obs.removeObserver(this, "http-on-examine-response");
    Services.obs.removeObserver(this, "content-document-global-created");
    Services.obs.removeObserver(this, "inner-window-destroyed");
    Services.obs.removeObserver(this, "outer-window-destroyed");
    Services.obs.removeObserver(this, "addon-options-displayed");
  }
};

/* NAT64 detection and checking. */
var NAT64 = {
  detectedPrefixes: null,
  detectAttempts: 0,

  // Automatically detect any NAT64 ranges in use by looking up
  // "ipv4only.arpa" and seeing if any AAAA records were synthesized.
  // This is the general method from RFC 7050, but this implementation
  // only detects NAT64 setups with the v4 address in the last 32 bits.
  detect: function(callback) {
    var dns = Cc["@mozilla.org/network/dns-service;1"]
                .createInstance(Ci.nsIDNSService);

    function convertRecordsToPrefixes(records) {
      if (!records) return null;

      let prefixes = [];
      while (records.hasMore()) {
        let record = records.getNextAddrAsString();
        if (record.match(/:c000:a[ab]$/)) {
          record = record.replace(/:c000:a[ab]$/, ":");
          if (prefixes.indexOf(record) == -1)
            prefixes.push(record);
        }
      }

      return prefixes;
    }

    var listener = {
      onLookupComplete: function(request, records, status) {
        var prefixes = convertRecordsToPrefixes(records);
        NAT64.detectedPrefixes = prefixes;
        NAT64.detectAttempts++;

        if (callback) callback(prefixes, request, records, status);
      }
    }

    dns.asyncResolve("ipv4only.arpa", dns.RESOLVE_BYPASS_CACHE, listener, null);
  },

  // Determine if a given address is inside a NAT64 range, based on
  // both the configured and the autodetected NAT64 ranges.
  isNAT64Address: function(address) {
    var prefixes = Preferences.get("extensions.ipvfox.nat64prefixes", "").split(/ /);
    if (this.detectedPrefixes) prefixes = prefixes.concat(this.detectedPrefixes);

    var matchingPrefixes = prefixes.filter(function(prefix) {
      if (prefix.length < 1) return false;
      try {
        var re = new RegExp("^" + prefix);
        if (address.match(re)) return true;
        else return false;
      } catch(e) { return false; };
    });
    return (matchingPrefixes.length > 0);
  }
}

/* Toolbar buttons. */
function insertPanel(window) {
  /* The panel itself. */
  var panel = window.document.createElement('panel');
  panel.id = "ipvfox-panel";
  panel.setAttribute("type", "arrow");
  
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
  panel.betterOpenPopup = function(anchor) {
    function addHostRow(host) {
      var row   = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:tr");
      var cell1 = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td");
      var cell2 = window.document.createElementNS("http://www.w3.org/1999/xhtml","html:td");
     
      cell1.appendChild(window.document.createTextNode(host.host));
      cell2.appendChild(window.document.createTextNode(host.address));
      
      if (host.family == AF_INET6)
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
    var domWinUtils = domWin.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils);
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
        addHostRow(hosts[i]);
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
        
      addHostRow(newentry);
    }
    RHCallbacks.push(handleCacheUpdate);
    
    /* Unsubscribe after the panel is closed. */
    panel.addEventListener("popuphiding", function() {
      panel.removeEventListener("popuphiding", arguments.callee, false);
      RHCallbacks = RHCallbacks.filter(function(el) el != handleCacheUpdate);
      panel.hidden = true;
    }, false);
    
    /* Close on tab switch. Built-in panels seem to get something similar
       automatically, although they also close on e.g. ctrl+f; this just takes
       care of the case where the panel contents will be wrong. */
    window.addEventListener("TabSelect", function() {
      window.removeEventListener("TabSelect", arguments.callee, false);
      panel.hidePopup();
    }, false);
    
    /* Work out which corner to put the arrow in. It should be positioned such that
       the popup is inside the Firefox window where possible. */
    position = (anchor.boxObject.y < (window.outerHeight / 2)) ?
      "bottomcenter top" : "topcenter bottom";
    position += (anchor.boxObject.x < (window.innerWidth / 2)) ?
      "left" : "right";
    
    /* Display popup */
    panel.hidden = false;
    panel.popupBoxObject.setConsumeRollupEvent(panel.popupBoxObject.ROLLUP_CONSUME);
    panel.openPopup(anchor, position, 0, 0, false, false);
  }
  
  return panel;
}

function createButton(window) {
  function makeImg(size, which) {
    var img = window.document.createElement('image');
    img.id = "ipvfox-" + size + "-" + which;
    img.setAttribute("src", "chrome://ipvfox/skin/" + size + "-" + which + ".png");
    return img;
  }
  
  var stack = window.document.createElement('stack');
  var deck = window.document.createElement('deck');
  stack.appendChild(deck);
  
  // Values are from the appropriate selectedIndex for the <deck> element
  var mainMap = new Object();
  mainMap[AF_UNSPEC] = 2;
  mainMap[AF_INET]   = 0;
  mainMap[AF_INET6]  = 1;
  
  ["4", "6", "q"].map(function (which) makeImg("big", which))
                 .forEach(function(img) deck.appendChild(img));
  
  var additionalMap = new Object();
  additionalMap[AF_INET]  = stack.appendChild(makeImg("small", "4"));
  additionalMap[AF_INET6] = stack.appendChild(makeImg("small", "6"));
  
  /* Functions to control what's visible. */
  stack.setMain = function(family) {
    deck.setAttribute("selectedIndex", mainMap[family]);
  }
  
  stack.setAdditional = function(family, has) {
    additionalMap[family].hidden = (has? 0 : 1);
  }

  /* Grayscale icon filter. */
  function updateGrayscaleAttribute() {
    stack.setAttribute("ipvfox-grayscale", Preferences.get("extensions.ipvfox.useGrayscaleButtons"));
  }
  Preferences.observe("extensions.ipvfox.useGrayscaleButtons", updateGrayscaleAttribute);
  unload(function() { Preferences.ignore("extensions.ipvfox.useGrayscaleButtons", updateGrayscaleAttribute); }, window);
  updateGrayscaleAttribute();
  
  /* Set the default state of the icon. */
  stack.setMain(AF_UNSPEC);
  stack.setAdditional(AF_INET, false);
  stack.setAdditional(AF_INET6, false);
  
  return stack;
}

function addIconUpdateHandlers(window, button) {
  var currentTabInnerID;
  var currentTabOuterID;
  
  function setCurrentTabIDs() {
    /* Fetch the nsIDomWindowUtils. */
    var domWin  = window.gBrowser.mCurrentBrowser.contentWindow;
    domWinUtils = domWin.QueryInterface(Ci.nsIInterfaceRequestor)
                        .getInterface(Ci.nsIDOMWindowUtils);
    
    currentTabInnerID = domWinUtils.currentInnerWindowID;
    currentTabOuterID = domWinUtils.outerWindowID;
    
    debuglog ("TabSelect handler: set current outer window ID to " + currentTabOuterID + ", inner window ID to " + currentTabInnerID);
  }
  
  function handler(evt) {
    debuglog("TabSelect handler: running")
    setCurrentTabIDs();
    
    /* Tab was changed, so clear the current state. */
    button.setMain(AF_UNSPEC);
    button.setAdditional(AF_INET, false);
    button.setAdditional(AF_INET6, false);
    
    /* Set state appropriately for the new tab. */
    var hosts = RHCache[currentTabInnerID];
    
    if (typeof(hosts) === 'undefined')
      return;
    
    /* The first entry may not always be the main host,
       if e.g. that page came from cache. */
    if (hosts[0].isMainHost) {
      button.setMain(hosts[0].family);
    }
    
    var additionalhosts = hosts.slice(hosts[0].isMainHost ? 1 : 0);
    if (additionalhosts.some(function(el) el.family == AF_INET))
      button.setAdditional(AF_INET, true);
    if (additionalhosts.some(function(el) el.family == AF_INET6))
      button.setAdditional(AF_INET6, true);
  }
  
  function handleCacheUpdate(updatedOuterID, newentry) {
    debuglog ("Cache update handler for button: Updated ID: " +  updatedOuterID + ", hoping for " + currentTabOuterID);
    debuglog ("By the way, there are " + RHCallbacks.length + " handlers registered.");
    
    if (updatedOuterID != currentTabOuterID)
      return;
    
    if (newentry == null) {
      /* New page: clear image state. */
      button.setMain(AF_UNSPEC);
      button.setAdditional(AF_INET, false);
      button.setAdditional(AF_INET6, false);
      return;
    }
    
    if (newentry.isMainHost) {
      button.setMain(newentry.family);
    } else {
      button.setAdditional(newentry.family, true);
    }
  }
  
  /* We need the current outer tab ID to be set before
     the user has switched tabs for the first time. */
  setCurrentTabIDs();
  
  RHCallbacks.push(handleCacheUpdate);
  unload(function() {
    RHCallbacks = RHCallbacks.filter(function(el) el != handleCacheUpdate);
  }, window, true);
  
  window.gBrowser.tabContainer.addEventListener("TabSelect", handler, false);
  window.gBrowser.addEventListener("pageshow", handler, false);
  window.gBrowser.addEventListener("DOMContentLoaded", handler, false);

  unload(function() {
    window.gBrowser.tabContainer.removeEventListener("TabSelect", handler, false);
    window.gBrowser.removeEventListener("pageshow", handler, false);
    window.gBrowser.removeEventListener("DOMContentLoaded", handler, false);
  }, window);
}

function insertURLIcon(window, panel) {
  var stack = createButton(window);
  stack.id = "ipvfox-urlbar-button";
  stack.className = "urlbar-icon";
  
  var container = window.document.getElementById('urlbar-icons');
  container.insertBefore(stack, container.firstChild);
  addIconUpdateHandlers(window, stack);
  
  unload(function() {
    stack.parentNode.removeChild(stack);
  }, window);
  
  /* Add click handler. */
  stack.addEventListener("click", function(event) {
    if (event.button == 0) panel.betterOpenPopup(stack);
  }, false);
  
  return stack;
}

function insertToolbarButton(window, panel) {
  function addButtonToToolbar() {
    window.document.getElementById("navigator-toolbox").palette.appendChild(button);

    /* If the user has added the button to a toolbar, insert it at their location. */
    var toolbars = window.document.getElementsByTagName("toolbar");
    for (let i = 0; i < toolbars.length; i++) {
      var currentset = toolbars[i].getAttribute("currentset").split(",");
      var idx = currentset.indexOf(button.id);
      if (idx != -1) {
        /* Insert button. It needs to go before the first element
           listed in currentset that is actually on the toolbar. */
        for (let j = idx + 1; j < currentset.length; j++) {
          let elm = window.document.getElementById(currentset[j]);
          if (elm) {
            toolbars[i].insertItem(button.id, elm);
            return;
          }
        }
        /* Insert at end. */
        toolbars[i].insertItem(button.id);
        return;
      }
    }
  }
  
  var stack = createButton(window);
  stack.style.marginTop = "1px";
  stack.style.marginBottom = "1px";
  
  var button = window.document.createElement("toolbarbutton");
  button.id = "ipvfox-button";
  button.className = "chromeclass-toolbar-additional toolbarbutton-1";
  button.setAttribute("tooltiptext", "List of hosts used for the current site");
  button.setAttribute("label", "IPvFox");
  
  var label = window.document.createElement("label");
  label.setAttribute("class", "toolbarbutton-text");
  label.setAttribute("value", button.getAttribute("label"));
  label.style.margin = 0;
  label.style.textAlign = "center";
  
  button.addEventListener("command", function() panel.betterOpenPopup(button), false);
  
  button.appendChild(stack);
  button.appendChild(label);
  addButtonToToolbar();
  addIconUpdateHandlers(window, stack);
  
  unload(function() {
    button.parentNode.removeChild(button);
  }, window);
}

function delayedInsertURLIcon(window, panel) {
  function getWantedState() {
    if (Preferences.get("extensions.ipvfox.alwaysShowURLIcon", false)) {
      return true;
    } else {
      var toolbars = window.document.getElementsByTagName("toolbar");
      for (let i = 0; i < toolbars.length; i++) {
        var currentset = toolbars[i].getAttribute("currentset").split(",");
        var idx = currentset.indexOf("ipvfox-button");
        if (idx != -1) {
          return false;
        }
      }
      return true;
    }
  }
  
  function updateState() {
    var icon = window.document.getElementById("ipvfox-urlbar-button");
    if (getWantedState()) {
      debuglog("Showing button");
      if (!icon) icon = insertURLIcon(window, panel);
      icon.style.display = "";
    } else {
      debuglog("Hiding button");
      if (icon) icon.style.display = "none";
    }
  }
  
  window.addEventListener("aftercustomization", updateState, false);
  Preferences.observe("extensions.ipvfox.alwaysShowURLIcon", updateState);
  unload(function() {
    window.removeEventListener("aftercustomization", updateState, false);
    Preferences.ignore("extensions.ipvfox.alwaysShowURLIcon", updateState);
  }, window);
  
  updateState();
}

function insertBrowserCode(window) {
  var panel = insertPanel(window);
  
  insertToolbarButton(window, panel);
  /* Inserts the urlbar icon, subject to the alwaysShowURLIcon preference
     and the presence of the toolbar icon, and installs handlers to hide the
     button when necessary. Must go after the insertToolbarButton() call. */
  delayedInsertURLIcon(window, panel);
}

function logmsg(aMessage) {
  Services.console.logStringMessage("IPvFox: " + aMessage);
}

function debuglog(aMessage) {
  if (DEBUG) logmsg(aMessage);
}

function insertStyleSheet() {
  /* Insert stylesheet */
  var sSS = Cc["@mozilla.org/content/style-sheet-service;1"]
              .getService(Ci.nsIStyleSheetService);
  var fileURI = Services.io.newURI("chrome://ipvfox/skin/style.css", null, null);

  sSS.loadAndRegisterSheet(fileURI, sSS.AGENT_SHEET);
  unload(function() sSS.unregisterSheet(fileURI, sSS.AGENT_SHEET));
}

function setDefaultPrefs() {
  var branch = Services.prefs.getDefaultBranch("");
  branch.setBoolPref("extensions.ipvfox.alwaysShowURLIcon", false);
  branch.setBoolPref("extensions.ipvfox.detectEmbeddedv4", true);
  branch.setCharPref("extensions.ipvfox.nat64prefixes", "64:ff9b::");
  branch.setBoolPref("extensions.ipvfox.enableNAT64Autodetect", true);
  branch.setBoolPref("extensions.ipvfox.useGrayscaleButtons", false);
}

/**
 * Handle the extension being activated on install/enable.
 */
function startup(data, reason) {
  /* Register HTTP observer, add per-window code. */
  Cu.import("chrome://ipvfox/content/watchwindows.jsm");
  Cu.import("chrome://ipvfox/content/preferences.jsm");
  
  setDefaultPrefs();
  insertStyleSheet();
  httpRequestObserver.register();
  if (Preferences.get("extensions.ipvfox.enableNAT64Autodetect"))
    NAT64.detect();

  watchWindows(insertBrowserCode);
  debuglog("Registered.");
}

/**
 * Handle the extension being deactivated on uninstall/disable.
 */
function shutdown(data, reason) {
  // Clean up with unloaders when we're deactivating
  if (reason != APP_SHUTDOWN) {
    httpRequestObserver.unregister();
    unload();
    
    Cu.unload("chrome://ipvfox/content/preferences.jsm");
    Cu.unload("chrome://ipvfox/content/watchwindows.jsm");
  }
}

/**
 * Handle the extension being installed.
 */
function install(data, reason) {}

/**
 * Handle the extension being uninstalled.
 */
function uninstall(data, reason) {}
