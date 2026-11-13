#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <string>
#include <vector>

struct PermissionResult { int authorization; bool alerts; bool center; };

static void CallJS(napi_env env, napi_value callback, void*, void* raw) {
  auto result = static_cast<PermissionResult*>(raw);
  if (env && callback) {
    napi_value object, number, alerts, center, receiver;
    napi_create_object(env, &object);
    napi_create_int32(env, result->authorization, &number);
    napi_get_boolean(env, result->alerts, &alerts);
    napi_get_boolean(env, result->center, &center);
    napi_set_named_property(env, object, "authorization", number);
    napi_set_named_property(env, object, "alerts", alerts);
    napi_set_named_property(env, object, "center", center);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &object, nullptr);
  }
  delete result;
}

static void ReadSettings(napi_threadsafe_function callback) {
  [[UNUserNotificationCenter currentNotificationCenter] getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
    auto result = new PermissionResult{static_cast<int>(settings.authorizationStatus),
      settings.alertSetting == UNNotificationSettingEnabled,
      settings.notificationCenterSetting == UNNotificationSettingEnabled};
    if (napi_call_threadsafe_function(callback, result, napi_tsfn_nonblocking) != napi_ok) delete result;
    napi_release_threadsafe_function(callback, napi_tsfn_release);
  }];
}

static void DeliveredJS(napi_env env, napi_value callback, void*, void* raw) {
  auto ids = static_cast<std::vector<std::string>*>(raw);
  if (env && callback) {
    napi_value array, value, receiver;
    napi_create_array_with_length(env, ids->size(), &array);
    for (size_t i = 0; i < ids->size(); i++) {
      napi_create_string_utf8(env, (*ids)[i].c_str(), NAPI_AUTO_LENGTH, &value);
      napi_set_element(env, array, i, value);
    }
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &array, nullptr);
  }
  delete ids;
}

static napi_value Invoke(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], name, result;
  void* request;
  napi_get_cb_info(env, info, &argc, args, nullptr, &request);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected a callback"); return nullptr;
  }
  napi_create_string_utf8(env, "iBridgeNotificationPermission", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function callback;
  const bool delivered = request == reinterpret_cast<void*>(2);
  if (napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, delivered ? DeliveredJS : CallJS, &callback) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to read notification permissions"); return nullptr;
  }
  @autoreleasepool {
    if (delivered) {
      [[UNUserNotificationCenter currentNotificationCenter] getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification*>* notifications) {
        auto ids = new std::vector<std::string>();
        for (UNNotification* notification in notifications) ids->push_back(notification.request.identifier.UTF8String);
        if (napi_call_threadsafe_function(callback, ids, napi_tsfn_nonblocking) != napi_ok) delete ids;
        napi_release_threadsafe_function(callback, napi_tsfn_release);
      }];
    } else if (request) {
      [[UNUserNotificationCenter currentNotificationCenter]
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL, NSError*) { ReadSettings(callback); }];
    } else ReadSettings(callback);
  }
  napi_get_undefined(env, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"get", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"delivered", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(2)},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
