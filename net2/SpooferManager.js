/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict'

const firewalla = require('./Firewalla.js');

const BitBridge = require('../extension/bitbridge/bitbridge.js')

const iptool = require('ip')

const rclient = require('../util/redis_manager.js').getRedisClient()
const minimatch = require('minimatch');

const log = require("./logger.js")(__filename, 'info');

const monitoredKey = "monitored_hosts";
const unmonitoredKey = "unmonitored_hosts";
const unmonitoredKeyAll = "unmonitored_hosts_all";
const monitoredKey6 = "monitored_hosts6";
const unmonitoredKey6 = "unmonitored_hosts6";

const HostTool = require('../net2/HostTool')
const hostTool = new HostTool();
const fc = require('./config.js')

const exec = require('child-process-promise').exec

let instance = null;

module.exports = class SpooferManager {
  constructor() {
    if (!instance) {
      this.spoofStarted = false;
      this.registeredSpoofInstances = {};
      /*
      (async () => {
        const gatewayIp = sysManager.myGateway();
        this.gatewayMac = await hostTool.getMacByIP(gatewayIp);
      })();
      */

      if (firewalla.isMain()) {
        // need to find a better way to do this
        /*
        sem.on("DeviceUpdate", (event) => {
          const ipv6Addr = event.host.ipv6Addr;
          if (sysManager.myGateway6() && sysManager.myIp6() && this.gatewayMac && event.host.mac === this.gatewayMac
            && ipv6Addr && Array.isArray(ipv6Addr) && sysManager.myDNS().includes(sysManager.myGateway())) {
            // v4 dns includes gateway ip, very likely gateway's v6 addresses are dns servers, need to spoof these addresses (no matter public or linklocal)
            try {
              log.info("Router also acts as dns, spoof all router's v6 addresses: ", ipv6Addr);
              for (const addr of ipv6Addr) {
                this.registerSpoofInstance(sysManager.monitoringInterface().name, addr, sysManager.myIp6(), true);
              }
            } catch(err) {
              log.error("Error register new spoofer on device update", err)
            }
          }
        });

        sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_RELOADED);

        sclient.on("message", (channel, message) => {
          switch (channel) {
            case Message.MSG_SYS_NETWORK_INFO_RELOADED:
              if (sysManager.myGateway() && sysManager.myIp()) {
                this.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway(), sysManager.myIp(), false);
              }
              if (sysManager.myGateway6() && sysManager.myIp6() && sysManager.myIp6().length) {
                this.registerSpoofInstance(sysManager.monitoringInterface().name, sysManager.myGateway6(), sysManager.myIp6()[0], true);
              }
              break;
            default:
          }
        });
        */

        // feature change listener
        (async () => {
          let ipv6Default = false;
          if (firewalla.isBeta() || firewalla.isAlpha() || firewalla.isDevelopmentVersion()) {
            ipv6Default = true;
          }
          if(fc.isFeatureOn("ipv6", ipv6Default)) {
            await fc.enableDynamicFeature("ipv6"); // ensure dynamic feature flag is set
            await this.ipv6On();
          } else {
            await fc.disableDynamicFeature("ipv6"); // ensure dynamic feature flag is cleared
            await this.ipv6Off();
          }
          fc.onFeature("ipv6", (feature, status) => {
            if(feature != "ipv6")
              return

            if(status) {
              this.ipv6On()
            } else {
              this.ipv6Off()
            }
          })
        })()
      }
      instance = this;
    }
    return instance;
  }

  async registerSpoofInstance(intf, routerIP, selfIP, isV6) {
    const key = this._getSpoofInstanceKey(intf, routerIP, isV6);
    if (!key)
      return;

    if (!this.registeredSpoofInstances[key]) {
      this.registeredSpoofInstances[key] = BitBridge.createInstance(intf, routerIP, selfIP, isV6);
      if (this.spoofStarted) {
        await this.registeredSpoofInstances[key].start();
      }
    } else {
      const oldInstance = this.registeredSpoofInstances[key];
      const newInstance = BitBridge.createInstance(intf, routerIP, selfIP, isV6);
      if (newInstance !== oldInstance) {
        // need to deregister old instance
        await this.deregisterSpoofInstance(intf, routerIP, isV6);
        this.registeredSpoofInstances[key] = newInstance;
        await newInstance.start();
        this.scheduleReload();
      }
    }
  }

  async deregisterSpoofInstance(intf, routerIP, isV6) {
    const keyPattern = this._getSpoofInstanceKey(intf, routerIP, isV6);
    if (!keyPattern)
      return;

    // deregister accept wildcard, e.g., eth0_v6_*
    for (let key in this.registeredSpoofInstances) {
      if (minimatch(key, keyPattern)) {
        const spoofInstance = this.registeredSpoofInstances[key];
        await spoofInstance.stop();
        this.scheduleReload();
        await this.emptySpoofSet(intf);
        delete this.registeredSpoofInstances[key];
      }
    }
  }

  _getSpoofInstanceKey(intf, routerIP, isV6) {
    isV6 = isV6 || false;
    if (!intf || !routerIP)
      return null;
    if (isV6) {
      // allow spoof multiple router IPs on one interface for IPv6
      return `${intf}_v6_${routerIP}`;
    } else {
      // allow only one spoof instance on one interface for IPv4
      return `${intf}_v4`;
    }
  }

  async ipv6On() {
    try {
      await exec("touch /home/pi/.firewalla/config/enablev6");
      await exec("pgrep -x bitbridge6 && sudo pkill bitbridge6; true");
    } catch(err) {
      log.warn("Error when turn on ipv6", err);
    }
  }

  async ipv6Off() {
    try {
      await exec("rm -f /home/pi/.firewalla/config/enablev6");
      await exec("pgrep -x bitbridge6 && sudo pkill bitbridge6; true");
    } catch(err) {
      log.warn("Error when turn off ipv6", err);
    }
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    // multiple processes belong to bitbridge services. Stop can ensure all processes are stopped before start
    this.reloadTask = setTimeout(async () => {
      await exec(`sudo systemctl stop bitbridge4;`).catch((err) => {});
      await exec(`sudo systemctl stop bitbridge6;`).catch((err) => {});
      if (this.spoofStarted) {
        await exec(`sudo systemctl restart bitbridge4`).catch((err) => {
          log.error("Failed to start bitbridge4", err.message);
        });
        await exec(`sudo systemctl restart bitbridge6`).catch((err) => {
          log.error("Failed to start bitbridge6", err.message);
        });
      }
    }, 3000);
  }

  async startSpoofing() {

    if(this.spoofStarted) {
      return;
    }

    log.info("start spoofing")

    await this.emptySpoofSet(); // all monitored_hosts* keys are cleared during startup

    await BitBridge.cleanupSpoofInstanceConfigs(); // cleanup Bitbridge config files (*.rc)

    for (let key in this.registeredSpoofInstances) {
      const spoofInstance = this.registeredSpoofInstances[key];
      await spoofInstance.start();
    }

    this.spoofStarted = true;
    this.scheduleReload();
  }

  async stopSpoofing() {
    this.spoofStarted = false;

    for (let key in this.registeredSpoofInstances) {
      const spoofInstance = this.registeredSpoofInstances[key];
      await spoofInstance.stop().catch((err) => {
        log.error(`Failed to stop spoof instance ${key}`, err);
      });
    }
    this.scheduleReload();
  }

  async directSpoof(ip) {
    if(iptool.isV4Format(ip)) {
    } else if(iptool.isV6Format(ip)) {
      await rclient.saddAsync(monitoredKey6, ip)
    } else {
      throw new Error("Invalid ip address: " + ip)
    }
  }

  async emptySpoofSet(intf) {
    if (intf) {
      // clean up per-interface redis key
      const monitoredHostsKey = `monitored_hosts_${intf}`;
      const unmonitoredHostsKey = `unmonitored_hosts_${intf}`;
      const monitoredHostsKey6 = `monitored_hosts6_${intf}`;
      await rclient.delAsync(monitoredHostsKey);
      await rclient.delAsync(unmonitoredHostsKey);
      await rclient.delAsync(monitoredHostsKey6);
    } else {
      // clean up summarized redis key
      await rclient.delAsync(monitoredKey)
      await rclient.delAsync(unmonitoredKey)
      await rclient.delAsync(unmonitoredKeyAll)
      await rclient.delAsync(monitoredKey6)
      await rclient.delAsync(unmonitoredKey6)
    }
  }

  async loadManualSpoof(mac) {
    let key = hostTool.getMacKey(mac)
    let host = await rclient.hgetallAsync(key)
    let manualSpoof = (host.manualSpoof === '1' ? true : false)
    if(manualSpoof) {
      await rclient.saddAsync(monitoredKey, host.ipv4Addr)
      await rclient.sremAsync(unmonitoredKey, host.ipv4Addr)
      await rclient.sremAsync(unmonitoredKeyAll, host.ipv4Addr)
    } else {
      await rclient.sremAsync(monitoredKey, host.ipv4Addr)
      await rclient.saddAsync(unmonitoredKey, host.ipv4Addr)
      await rclient.saddAsync(unmonitoredKeyAll, host.ipv4Addr)
      setTimeout(() => {
        rclient.sremAsync(unmonitoredKey, host.ipv4Addr)
      }, 8 * 1000) // remove ip from unmonitoredKey after 8 seconds to reduce battery cost of unmonitored devices
    }
  }

  async loadManualSpoofs(hostManager) {
    log.info("Reloading manual spoof configurations...")
    let activeMACs = hostManager.getActiveMACs()

    await this.emptySpoofSet() // this is to ensure no other ip addresses are added to the list
    for (const mac of activeMACs) {
      await this.loadManualSpoof(mac)
    }
  }


  async isSpoofRunning() {
    try {
      await exec("pgrep -x bitbridge7")

      // TODO: add ipv6 check in the future
    } catch(err) {
      // error means no bitbridge7 is available
      log.warn("service bitbridge7 is not running (yet)")
      return false
    }
    return true
  }

  // TODO support ipv6
  async isSpoof(ip) {
    try {
      await exec("pgrep -x bitbridge7")

      // TODO: add ipv6 check in the future
    } catch(err) {
      // error means no bitbridge7 is available
      log.warn("service bitbridge7 is not running (yet)")
      return false
    }

    // BitBridge.getInstance() is not available for other nodejs processes than FireMain
    /*
    let instance = BitBridge.getInstance()
    if(!instance) {
      return false
    }

    let started = instance.started
    if(!started) {
      return false
    }
    */

    return await rclient.sismemberAsync(monitoredKey, ip) == 1
  }
}
