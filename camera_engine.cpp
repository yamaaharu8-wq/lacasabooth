#include <node_api.h>

// 1. Ini adalah fungsi C++ Murni yang sangat cepat
napi_value PingKamera(napi_env env, napi_callback_info info) {
    napi_value hasil;
    // C++ membuat sebuah teks (string) untuk dikirim ke JavaScript
    napi_create_string_utf8(env, "🚀 SUKSES! Ini adalah pesan dari mesin C++ Lacasaphoto!", NAPI_AUTO_LENGTH, &hasil);
    return hasil;
}

// 2. Jembatan untuk mengekspor fungsi C++ agar bisa dibaca oleh Node.js / Electron
napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, nullptr, 0, PingKamera, nullptr, &fn);
    napi_set_named_property(env, exports, "ping", fn);
    return exports;
}

// 3. Mendaftarkan modul
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)