/*    Copyright 2019 Firewalla Inc.
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

'use strict';

// this module should be responsible for connecting firewalla and fireroute together
// more specifically:
//    inquery and update regarding to
//      physical/bridge/virtual interfaces, DNS, NAT, DHCP
//    serving as FireRouter on RED & BLUE
//      create secondaryInterface
//      start bro, dnsmasq if necessary
//      generating compatible config


//  An Interface class?
//  {
//    name
//    gateway: {ipv4, ipv4}
//    subnet
//    dnsmasq as a pre-interface instance?
//  }

const log = require("./logger.js")(__filename);

const f = require('../net2/Firewalla.js');
const SysTool = require('../net2/SysTool.js')
const sysTool = new SysTool()
const broControl = require('./BroControl.js')
const PlatformLoader = require('../platform/PlatformLoader.js')
const Config = require('./config.js')
const rclient = require('../util/redis_manager.js').getRedisClient()
const { delay } = require('../util/util.js')
const pclient = require('../util/redis_manager.js').getPublishClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('./Message.js');

const util = require('util')
const rp = util.promisify(require('request'))
const { Address4, Address6 } = require('ip-address')
const uuid = require('uuid');
const _ = require('lodash');
const Mode = require('./Mode.js');

// not exposing these methods/properties
async function localGet(endpoint) {
  const options = {
    method: "GET",
    headers: {
      "Accept": "application/json"
    },
    url: routerInterface + endpoint,
    json: true
  };

  const resp = await rp(options)
  if (resp.statusCode !== 200) {
    throw new Error(`Error getting ${endpoint}`);
  }

  return resp.body
}

async function getConfig() {
  return localGet("/config/active")
}

async function getWANInterfaces() {
  return localGet("/config/wans")
}

async function getLANInterfaces() {
  return localGet("/config/lans")
}

async function getInterfaces() {
  return localGet("/config/interfaces")
}

function updateMaps() {
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    intf.config.meta.intfName = intfName
    intfUuidMap[intf.config.meta.uuid] = intf
  }
}

async function generateNetworkInfo() {
  const networkInfos = [];
  for (const intfName in intfNameMap) {
    const intf = intfNameMap[intfName]
    const ip4 = intf.state.ip4 ? new Address4(intf.state.ip4) : null;
    let ip6s = [];
    let ip6Masks = [];
    let ip6Subnets = [];
    if (intf.state.ip6 && _.isArray(intf.state.ip6)) {
      for (let i of intf.state.ip6) {
        const ip6Addr = new Address6(i);
        if (!ip6Addr.isValid())
          continue;
        ip6s.push(ip6Addr.correctForm());
        ip6Masks.push(new Address6(`ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/${ip6Addr.subnetMask}`).startAddress().correctForm());
        ip6Subnets.push(i);
      }
    }
    let gateway = null;
    let gateway6 = null;
    let dns = null;
    switch (intf.config.meta.type) {
      case "wan": {
        gateway = intf.config.gateway || intf.state.gateway;
        gateway6 = intf.config.gateway6 || intf.state.gateway6;
        dns = intf.config.nameservers || intf.state.dns;
        break;
      }
      case "lan": {
        // no gateway and dns for lan interface, gateway and dns in dhcp does not mean the same thing
        gateway = null;
        gateway6 = null;
        dns = null;
        break
      }
    }
    const redisIntf = {
      name:         intfName,
      uuid:         intf.config.meta.uuid,
      mac_address:  intf.state.mac,
      ip_address:   ip4 ? ip4.addressMinusSuffix : null,
      subnet:       intf.state.ip4,
      netmask:      ip4 ? Address4.fromInteger(((0xffffffff << (32-ip4.subnetMask)) & 0xffffffff) >>> 0).address : null,
      gateway_ip:   gateway,
      gateway:      gateway,
      ip6_addresses: ip6s.length > 0 ? ip6s : null,
      ip6_subnets:  ip6Subnets.length > 0 ? ip6Subnets : null,
      ip6_masks:    ip6Masks.length > 0 ? ip6Masks : null,
      gateway6:     gateway6,
      dns:          dns,
      carrier:      intf.state && intf.state.carrier == 1,
      conn_type:    'Wired', // probably no need to keep this,
      type:         intf.config.meta.type
    }

    await rclient.hsetAsync('sys:network:info', intfName, JSON.stringify(redisIntf))
    await rclient.hsetAsync('sys:network:uuid', redisIntf.uuid, JSON.stringify(redisIntf))
    networkInfos.push(redisIntf);
  }
  if (f.isMain()) {
    await pclient.publishAsync(Message.MSG_SYS_NETWORK_INFO_UPDATED, "");
  }
  return networkInfos;
}

let routerInterface = null
let routerConfig = null
let monitoringIntfNames = null
let wanIntfNames = null
let defaultWanIntfName = null
let intfNameMap = {}
let intfUuidMap = {}


class FireRouter {
  constructor() {
    this.platform = PlatformLoader.getPlatform()
    log.info(`This platform is: ${this.platform.constructor.name}`);

    const fwConfig = Config.getConfig();

    if (!fwConfig.firerouter || !fwConfig.firerouter.interface) return null

    const intf = fwConfig.firerouter.interface;
    routerInterface = `http://${intf.host}:${intf.port}/${intf.version}`;

    
    this.ready = false
    this.sysNetworkInfo = [];

    this.init(true).catch(err => {
      log.error('FireRouter failed to initialize', err)
      process.exit(1);
    })

    sclient.on("message", (channel, message) => {
      switch (channel) {
        case Message.MSG_FR_CHANGE_APPLIED:
        case Message.MSG_NETWORK_CHANGED: {
          // these two message types should cover all proactive and reactive network changes
          log.info("Network is changed, schedule reload from FireRouter ...");
          this.scheduleReload();
        }
        break;
      }
    });

    sclient.subscribe(Message.MSG_FR_CHANGE_APPLIED);
    sclient.subscribe(Message.MSG_NETWORK_CHANGED);
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.init();
    }, 3000);
  }

  // let it crash
  async init(first = false) {
    if (this.platform.isFireRouterManaged()) {
      // fireroute
      routerConfig = await getConfig()

      const mode = await rclient.getAsync('mode')

      const lastConfig = await this.loadLastConfigFromHistory(mode);
      if (!lastConfig || ! _.isEqual(lastConfig.config, routerConfig)) {
        await this.saveConfigHistory(routerConfig, mode);
      }

      // const wans = await getWANInterfaces();
      // const lans = await getLANInterfaces();

      // Object.assign(intfNameMap, wans, lans)
      intfNameMap = await getInterfaces()

      updateMaps()

      this.sysNetworkInfo = await generateNetworkInfo()

      // extract WAN interface names
      wanIntfNames = Object.values(intfNameMap)
        .filter(intf => intf.config.meta.type == 'wan')
        .map(intf => intf.config.meta.intfName);

      // extract default route interface name
      defaultWanIntfName = null;
      if (routerConfig && routerConfig.routing && routerConfig.routing.global && routerConfig.routing.global.default) {
        const defaultRoutingConfig = routerConfig.routing.global.default;
        if (defaultRoutingConfig.viaIntf)
          defaultWanIntfName = defaultRoutingConfig.viaIntf;
        else {
          if (defaultRoutingConfig.nextHops && defaultRoutingConfig.nextHops.length > 0) {
            // load balance default route, choose the fisrt one as default WAN
            defaultWanIntfName = defaultRoutingConfig.nextHops[0].viaIntf;
          }
        }
      }
      if (!defaultWanIntfName )
        log.error("Default WAN interface is not defined in router config");
      

      switch(mode) {
        case Mode.MODE_AUTO_SPOOF:
        case Mode.MODE_DHCP:
        case Mode.MODE_NONE:
          // monitor both wan and lan in simple mode
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type === 'wan' || intf.config.meta.type === 'lan')
            .map(intf => intf.config.meta.intfName)
          break;

        case Mode.MODE_ROUTER:
          // only monitor lan in router mode
          monitoringIntfNames = Object.values(intfNameMap)
            .filter(intf => intf.config.meta.type === 'lan')
            .map(intf => intf.config.meta.intfName)
          break;
        default:
          // do nothing for other mode
          monitoringIntfNames = [];
      }

      // Legacy code compatibility
      const updatedConfig = {
        discovery: {
          networkInterfaces: monitoringIntfNames
        },
        monitoringInterface: monitoringIntfNames[0]
      };
      Config.updateUserConfigSync(updatedConfig);

    } else {
      // make sure there is at least one usable ethernet
      const networkTool = require('./NetworkTool.js')();
      // updates userConfig
      const intf = await networkTool.updateMonitoringInterface().catch((err) => {
        log.error('Error', err)
      })

      routerConfig = {
        "interface": {
          "phy": {
            [intf]: {
              "enabled": true
            }
          }
        },
        "routing": {
          "global": {
            "default": {
              "viaIntf": intf
            }
          }
        },
        "dns": {
          "default": {
            "useNameserversFromWAN": true
          },
          [intf]: {
            "useNameserversFromWAN": true
          }
        },
        // "dhcp": {
        //   "br0": {
        //     "gateway": "10.0.0.1",
        //     "subnetMask": "255.255.255.0",
        //     "nameservers": [
        //       "10.0.0.1"
        //     ],
        //     "searchDomain": [
        //       ".lan"
        //     ],
        //     "range": {
        //       "from": "10.0.0.10",
        //       "to": "10.0.0.250"
        //     },
        //     "lease": 86400
        //   }
        // }
      }

      const sysinfo = await rclient.hgetallAsync("sys:network:info")
      const mac = _.get(sysinfo, `${intf}.mac.mac_address`, '').toUpperCase();
      const ip = _.get(sysinfo, `${intf}.ip_address`, '');
      const gateway = _.get(sysinfo, `${intf}.gateway`, '');
      const _dns = _.get(sysinfo, `${intf}.dns`, []); 
      let v4dns = [];
      for (let i in _dns) {
        if (new Address4(_dns[i]).isValid()) {
          v4dns.push(_dns[i]);
        }
      }

      intfNameMap = {
        eth0: {
          config: {
            enabled: true,
            meta: {
              name: 'eth0',
              uuid: uuid.v4(),
            }
          },
          state: {
            mac: mac,
            ip4: ip,
            gateway: gateway,
            dns: v4dns
          }
        }
      }

      monitoringIntfNames = [ 'eth0', 'eth0:0' ]

      wanIntfNames = ['eth0'];
      defaultWanIntfName = "eth0";

      const Discovery = require('./Discovery.js');
      const d = new Discovery("nmap");

      // regenerate stub sys:network:uuid
      await rclient.delAsync("sys:network:uuid");
      const stubNetworkUUID = {
        "00000000-0000-0000-0000-000000000000": JSON.stringify({name: "eth0"}),
        "11111111-1111-1111-1111-111111111111": JSON.stringify({name: "eth0:0"})
      };
      await rclient.hmset("sys:network:uuid", stubNetworkUUID);
      // updates sys:network:info
      const intfList = await d.discoverInterfacesAsync()
      if (!intfList.length) {
        throw new Error('No active ethernet!')
      }
      this.sysNetworkInfo = intfList;
    }

    log.info('FireRouter initialization complete')
    this.ready = true

    if (f.isMain() && (
      this.platform.isFireRouterManaged() && broControl.interfaceChanged(monitoringIntfNames) ||
      !this.platform.isFireRouterManaged() && first
    )) {
      this.broReady = false;
      if(this.platform.isFireRouterManaged()) {
        await broControl.writeClusterConfig(monitoringIntfNames)
      }
      // do not await bro restart to finish, it may take some time
      broControl.restart().then(() => broControl.addCronJobs()).then(() => {
        log.info('Bro restarted');
        this.broReady = true;
      });
    } else {
      log.info('Bro restarted');
      this.broReady = true;
    }
  }

  isReady() {
    return this.ready
  }

  isBroReady() {
    return this.broReady
  }

  async waitTillReady() {
    if (this.ready) return

    await delay(1)
    return this.waitTillReady()
  }

  getInterfaceViaName(name) {
    if (!_.has(intfNameMap, name)) {
      return null;
    }

    return JSON.parse(JSON.stringify(intfNameMap[name]))
  }

  getInterfaceViaUUID(uuid) {
    if (!_.has(intfUuidMap, uuid)) {
      return null;
    }

    return JSON.parse(JSON.stringify(intfUuidMap[uuid]))
  }

  getInterfaceAll() {
    return JSON.parse(JSON.stringify(intfNameMap))
  }

  getMonitoringIntfNames() {
    return JSON.parse(JSON.stringify(monitoringIntfNames))
  }

  getWanIntfNames() {
    return JSON.parse(JSON.stringify(wanIntfNames));
  }

  getDefaultWanIntfName() {
    return defaultWanIntfName;
  }

  getConfig() {
    return JSON.parse(JSON.stringify(routerConfig))
  }

  checkConfig(newConfig) {
    // TODO: compare firerouter config and return if firewalla service/box should be restarted
    return {
      serviceRestart: false,
      systemRestart: false,
    }
  }

  // call checkConfig() for the impact before actually commit it
  async setConfig(config) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: routerInterface + "/config/set",
      json: true,
      body: config
    };

    const resp = await rp(options)
    if (resp.statusCode !== 200) {
      throw new Error("Error setting firerouter config", resp.body);
    }

    const impact = this.checkConfig(config)

    if (impact.serviceRestart) {
      sysTool.rebootServices(5)
    }

    if (impact.systemRestart) {
      sysTool.rebootSystem(5)
    }

    // do not call this.init in setConfig, make this function pure
    // await this.init()
    // init of FireRouter should be triggered by published message
    await pclient.publishAsync(Message.MSG_NETWORK_CHANGED, "");

    return resp.body
  }

  getSysNetworkInfo() {
    return this.sysNetworkInfo;
  }

  async saveConfigHistory(config, mode) {
    if (!config || !mode) {
      log.error("Cannot save config, config or mode is not specified");
      return;
    }
    const key = `history:networkConfig:${mode}`;
    const time = Math.floor(Date.now() / 1000);
    await rclient.zaddAsync(key, time, JSON.stringify(config));
  }

  async loadLastConfigFromHistory(mode) {
    if (!mode) {
      log.error("Cannot load last config, mode is not specified");
      return null;
    }
    const history = await this.loadRecentConfigFromHistory(mode, 1);
    if (history && history.length > 0)
      return history[0];
    else return null;
  }

  async loadRecentConfigFromHistory(mode, count) {
    if (!mode) {
      log.error("Cannot load last config, mode is not specified");
      return [];
    }
    count = count || 10;
    const key = `history:networkConfig:${mode}`;
    const recentConfig = await rclient.zrevrangeAsync(key, 0, count, "withscores");
    const history = [];
    if (recentConfig && recentConfig.length > 0) {
      for (let i = 0; i < recentConfig.length; i++) {
        if (i % 2 === 0) {
          const configStr = recentConfig[i];
          try {
            const config = JSON.parse(configStr);
            const time = recentConfig[i + 1];
            history.push({config, time});
          } catch (err) {
            log.error(`Failed to parse config ${configStr}`);
          }
        }
      }
    }
    return history;
  }

  async applyLastConfigForMode(mode) {
    if (this.platform.isFireRouterManaged()) {
      switch (mode) {
        case Mode.MODE_AUTO_SPOOF: 
        case Mode.MODE_ROUTER: {
          let lastConfig = await this.loadLastConfigFromHistory(mode);
          lastConfig = lastConfig && lastConfig.config;
          if (!lastConfig) {
            // load default config
            if (mode === Mode.MODE_AUTO_SPOOF)
              lastConfig = require('./default_setup_simple.json');
            if (mode === Mode.MODE_ROUTER)
              lastConfig = require('./default_setup_router.json');
          }
          await this.setConfig(lastConfig);
          break;
        }
        default:
          log.error("Unsupported mode for Firerouter: ", mode);
      }
    } else {
      // red/blue, always apply network config for primary/secondary network no matter what the mode is
      const ModeManager = require('./ModeManager.js');
      await ModeManager.changeToAlternativeIpSubnet();
      await ModeManager.enableSecondaryInterface();
      await pclient.publishAsync(Message.MSG_NETWORK_CHANGED, "");
    }
  }
}

const instance = new FireRouter();
module.exports = instance;
