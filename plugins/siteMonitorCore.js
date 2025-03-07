#!/usr/bin/env node

/*
 * Features
 *  - get host list
 *  - get host information
 *  
 */

'use strict'
var fs = require('fs');
var program = require('commander');
var HostManager = require('./HostManager.js');
var sysmanager = require('./SysManager.js');
var FlowManager = require('./FlowManager.js');
var flowManager = new FlowManager('info');

program.version('0.0.2')
    .option('--host [host]', 'configuration')
    .option('--flows', '(optional) name')
    .option('--spoof', '(optional) name')
    .option('--pasthours [pasthours]', '(optional) name')
    .option('--hours [hours]', '(optional) name')
    .option('--interface [interface]', '(optional) name')
    .option('--notice ', '(optional) endpoint')
    .option('--dynaflow [dynaflow]', '(optional) endpoint') //dynamic flow listings, sorted by time

program.parse(process.argv);
let ip = null;

if (program.interface) {
    config.discovery.networkInterfaces = [program.interface];
}

let hours = 100;
let end = "+inf";
let start = "-inf";
if (program.hours) {
    hours = Number(program.hours);
}

let pasthours = 8;

if (program.pasthours) {
    pasthours = program.pasthours;
}

let now = Date.now() / 1000;
end = now;
start = now - Number(pasthours) * 60 * 60;


let config = {
    discovery: {
        networkInterfaces: ["eth0", "wlan0"],
    },
    monitoringInterface: 'eth0',
    bro: {
        notice: {
            monitor: {},
            ignore: {
                "SSL::Invalid_Server_Cert": "ignore",
                "PacketFilter::Dropped_Packets": "ignore",
            },
            path: "/blog/current/notice.log",
            expires: 86400 * 7,
        },
        intel: {
            path: "/blog/current/intel.log",
            expires: 86400 * 7,
            ignore: {
                'none': 'ignore',
            },
        },
        dns: {
            path: "/blog/current/dns.log",
            expires: 86400 * 1,
        },
        software: {
            path: "/blog/current/software.log",
            expires: 86400 * 7,
        },
        http: {
            path: "/blog/current/http.log",
            expires: 60 * 60 * 1,
        },
        ssl: {
            path: "/blog/current/ssl.log",
            expires: 86400 * 2,
        },
        conn: {
            path: "/blog/current/conn.log",
            //         flowstashExpires: 3600,
            flowstashExpires: 1800,
            //         flowstashExpires: 60*5,
            expires: 86400 * 1,
        },
        ssh: {
            path: "/blog/current/ssh.log",
            expires: 86400 * 1,
        },
        x509: {
            path: "/blog/current/x509.log",
            expires: 60 * 60 * 12,
        },
        userAgent: {
            expires: 86400 * 7,
        }


    }
};

sysmanager.update(null);

console.log("Mutlicast Test", sysmanager.isMulticastIP("223.0.0.1"));

var watcher = new HostManager("cli", 'client', 'info');

let c = require('./MessageBus.js');
this.subscriber = new c('debug');

this.subscriber.subscribe("DiscoveryEvent", "DiscoveryStart", null, (channel, ip, msg) => {
    console.log("Discovery Started");
});

async function flows(mac, direction) {
    let {connections, activities} = await flowManager.summarizeConnections(mac, direction, end, start, "time", hours, true,false);
        console.log("--- Connection by most recent ---", connections.length);
        let max = 10;
        if (program.dynaflow) {
            max = 100;
        }
        for (let i in connections) {
            let s = connections[i];
            if (program.dynaflow) {
                console.log(s.dhname);
            } else {
                console.log(flowManager.toStringShort(s));
            }
            if (max-- < 0) {
                break;
            }
        }
        flowManager.sort(connections, 'rxdata');
        console.log("-----------Sort by rx------------------------");
        max = 10;
        for (let i in connections) {
            let s = connections[i];
            console.log(flowManager.toStringShort(s));
            if (max-- < 0) {
                break;
            }
        }
        flowManager.sort(connections, 'txdata');
        console.log("-----------  Sort by tx------------------");
        max = 10;
        for (let i in connections) {
            let s = connections[i];
            console.log(flowManager.toStringShort(s));
            if (max-- < 0) {
                break;
            }
        }

        if (direction == 'in')
            await flows(mac, 'out');

        console.log("Contacting FlowManager");
        flowManager.getFlowCharacteristics(connections, direction, 1000000, 2);
}

setTimeout(() => {
    if (program.host == null) {
        watcher.getHosts((err, result) => {
            flowManager.summarizeBytes(result, end, start, (end - start) / 16, (err, sys) => {
                console.log("System Rx", sys);
                for (let i in result) {
                    console.log(result[i].toShortString(), result[i].flowsummary);
                    result[i].on("Notice:Detected", (type, ip, obj) => {
                        console.log("=================================");
                        console.log("Notice :", type, ip, obj);
                        console.log("=================================");
                    });
                    result[i].on("Intel:Detected", (type, ip, obj) => {
                        console.log("=================================");
                        console.log("Notice :", type, ip, obj);
                        console.log("=================================");
                    });
                    if (program.spoof) {
                        result[i].spoof(true);
                    }
                    result[i].redisCleanRange(48);
                    flows(result[i].o.mac, 'in');
                }
            });
        });
    } else {
        ip = program.host;

        console.log("Looking up host ", ip);
        watcher.getHost(ip, (err, result2) => {
            result2.getHost(ip, (err, result) => {
                console.log(result.toShortString());
                result.on("Notice:Detected", (channel, message) => {
                    console.log("============== Notice ======");
                    console.log(channel, message);
                });

                console.log("--- Software by count ---");
                for (let i in result.softwareByCount) {
                    //    console.log(result.softwareByCount[i].toShortString);
                    let s = result.softwareByCount[i];
                    console.log(s.name + "\t" + s.count + "\t" + s.lastActiveTimestamp);

                }
                console.log("--- Software by most recent ---");
                for (let i in result.softwareByCount) {
                    //    console.log(result.softwareByCount[i].toShortString);
                    let s = result.softwareByCount[i];
                    console.log(s.name + "\t" + s.count + "\t" + s.lastActiveTimestamp);

                }
                console.log("--- Connectionby most recent ---");

                flows(result[i].o.mac, 'in');

                if (program.spoof) {
                    result.spoof(true);
                }
            });
        });
    }
}, 2000);
