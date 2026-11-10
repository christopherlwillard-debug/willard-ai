{
  "targets": [
    {
      "target_name": "windows_safe_fs",
      "sources": ["windows_safe_fs.cc"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
