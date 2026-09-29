import {
  addPluginListener,
  invoke
} from "./chunk-IIKE5CJL.js";
import "./chunk-DC5AMYBS.js";

// ../../../../client/node_modules/@tauri-apps/plugin-notification/dist-js/index.js
var ScheduleEvery;
(function(ScheduleEvery2) {
  ScheduleEvery2["Year"] = "year";
  ScheduleEvery2["Month"] = "month";
  ScheduleEvery2["TwoWeeks"] = "twoWeeks";
  ScheduleEvery2["Week"] = "week";
  ScheduleEvery2["Day"] = "day";
  ScheduleEvery2["Hour"] = "hour";
  ScheduleEvery2["Minute"] = "minute";
  ScheduleEvery2["Second"] = "second";
})(ScheduleEvery || (ScheduleEvery = {}));
var Schedule = class {
  static at(date, repeating = false, allowWhileIdle = false) {
    return {
      at: { date, repeating, allowWhileIdle },
      interval: void 0,
      every: void 0
    };
  }
  static interval(interval, allowWhileIdle = false) {
    return {
      at: void 0,
      interval: { interval, allowWhileIdle },
      every: void 0
    };
  }
  static every(kind, count, allowWhileIdle = false) {
    return {
      at: void 0,
      interval: void 0,
      every: { interval: kind, count, allowWhileIdle }
    };
  }
};
var Importance;
(function(Importance2) {
  Importance2[Importance2["None"] = 0] = "None";
  Importance2[Importance2["Min"] = 1] = "Min";
  Importance2[Importance2["Low"] = 2] = "Low";
  Importance2[Importance2["Default"] = 3] = "Default";
  Importance2[Importance2["High"] = 4] = "High";
})(Importance || (Importance = {}));
var Visibility;
(function(Visibility2) {
  Visibility2[Visibility2["Secret"] = -1] = "Secret";
  Visibility2[Visibility2["Private"] = 0] = "Private";
  Visibility2[Visibility2["Public"] = 1] = "Public";
})(Visibility || (Visibility = {}));
async function isPermissionGranted() {
  if (window.Notification.permission !== "default") {
    return await Promise.resolve(window.Notification.permission === "granted");
  }
  return await invoke("plugin:notification|is_permission_granted");
}
async function requestPermission() {
  return await window.Notification.requestPermission();
}
function sendNotification(options) {
  if (typeof options === "string") {
    new window.Notification(options);
  } else {
    new window.Notification(options.title, options);
  }
}
async function registerActionTypes(types) {
  await invoke("plugin:notification|register_action_types", { types });
}
async function pending() {
  return await invoke("plugin:notification|get_pending");
}
async function cancel(notifications) {
  await invoke("plugin:notification|cancel", { notifications });
}
async function cancelAll() {
  await invoke("plugin:notification|cancel");
}
async function active() {
  return await invoke("plugin:notification|get_active");
}
async function removeActive(notifications) {
  await invoke("plugin:notification|remove_active", { notifications });
}
async function removeAllActive() {
  await invoke("plugin:notification|remove_active");
}
async function createChannel(channel) {
  await invoke("plugin:notification|create_channel", { ...channel });
}
async function removeChannel(id) {
  await invoke("plugin:notification|delete_channel", { id });
}
async function channels() {
  return await invoke("plugin:notification|listChannels");
}
async function onNotificationReceived(cb) {
  return await addPluginListener("notification", "notification", cb);
}
async function onAction(cb) {
  return await addPluginListener("notification", "actionPerformed", cb);
}
export {
  Importance,
  Schedule,
  ScheduleEvery,
  Visibility,
  active,
  cancel,
  cancelAll,
  channels,
  createChannel,
  isPermissionGranted,
  onAction,
  onNotificationReceived,
  pending,
  registerActionTypes,
  removeActive,
  removeAllActive,
  removeChannel,
  requestPermission,
  sendNotification
};
//# sourceMappingURL=@tauri-apps_plugin-notification.js.map
