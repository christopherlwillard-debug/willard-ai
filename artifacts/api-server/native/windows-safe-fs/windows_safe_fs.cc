#define _WIN32_WINNT 0x0602
#define NAPI_VERSION 8

#include <node_api.h>

#ifdef _WIN32

#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

class Handle {
 public:
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~Handle() {
    if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) CloseHandle(value_);
  }

  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;

  Handle(Handle&& other) noexcept : value_(other.value_) {
    other.value_ = INVALID_HANDLE_VALUE;
  }

  Handle& operator=(Handle&& other) noexcept {
    if (this == &other) return *this;
    if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) CloseHandle(value_);
    value_ = other.value_;
    other.value_ = INVALID_HANDLE_VALUE;
    return *this;
  }

  HANDLE get() const { return value_; }
  bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE release() {
    HANDLE result = value_;
    value_ = INVALID_HANDLE_VALUE;
    return result;
  }

 private:
  HANDLE value_;
};

struct RootContext {
  Handle handle;
  std::wstring canonicalPath;
};

struct DirectoryEntry {
  std::wstring name;
  bool isDirectory;
  uint64_t sizeBytes;
  double modifiedAtMs;
};

std::string narrowAscii(const std::wstring& value) {
  std::string result;
  result.reserve(value.size());
  for (wchar_t character : value) {
    result.push_back(character >= 0 && character <= 0x7f ? static_cast<char>(character) : '?');
  }
  return result;
}

std::wstring valueToWide(napi_env env, napi_value value) {
  size_t length = 0;
  napi_status status = napi_get_value_string_utf16(env, value, nullptr, 0, &length);
  if (status != napi_ok) throw std::runtime_error("Expected a UTF-16 path string.");

  std::vector<char16_t> buffer(length + 1);
  size_t written = 0;
  status = napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &written);
  if (status != napi_ok) throw std::runtime_error("Unable to read a UTF-16 path string.");

  static_assert(sizeof(wchar_t) == sizeof(char16_t), "Windows paths require 16-bit wchar_t.");
  return std::wstring(reinterpret_cast<const wchar_t*>(buffer.data()), written);
}

napi_value wideToValue(napi_env env, const std::wstring& value) {
  napi_value result;
  napi_status status = napi_create_string_utf16(
    env,
    reinterpret_cast<const char16_t*>(value.data()),
    value.size(),
    &result
  );
  if (status != napi_ok) throw std::runtime_error("Unable to create a UTF-16 result string.");
  return result;
}

std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t maximum) {
  std::vector<napi_value> values(maximum);
  size_t count = maximum;
  napi_status status = napi_get_cb_info(env, info, &count, values.data(), nullptr, nullptr);
  if (status != napi_ok) throw std::runtime_error("Unable to read native function arguments.");
  values.resize(count);
  return values;
}

void callOptionalHook(napi_env env, const std::vector<napi_value>& args, size_t index) {
  if (args.size() <= index) return;

  napi_valuetype type;
  if (napi_typeof(env, args[index], &type) != napi_ok || type == napi_undefined || type == napi_null) return;
  if (type != napi_function) throw std::runtime_error("The optional native test hook must be a function.");

  napi_value global;
  napi_value ignored;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_call_function(env, global, args[index], 0, nullptr, &ignored) != napi_ok) {
    throw std::runtime_error("The native filesystem test hook failed.");
  }
}

std::wstring toExtendedPath(const std::wstring& input) {
  if (input.empty()) throw std::runtime_error("The filesystem path is empty.");
  if (input.rfind(L"\\\\.\\", 0) == 0 ||
      input.rfind(L"\\\\?\\GLOBALROOT", 0) == 0 ||
      input.rfind(L"\\??\\", 0) == 0) {
    throw std::runtime_error("Device namespace paths are not supported.");
  }
  if (input.rfind(L"\\\\?\\", 0) == 0) return input;

  DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (required == 0) throw std::runtime_error("Unable to normalize the filesystem path.");
  std::vector<wchar_t> buffer(required + 1);
  DWORD written = GetFullPathNameW(input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (written == 0 || written >= buffer.size()) {
    throw std::runtime_error("Unable to normalize the filesystem path.");
  }

  std::wstring absolute(buffer.data(), written);
  if (absolute.rfind(L"\\\\", 0) == 0) return L"\\\\?\\UNC\\" + absolute.substr(2);
  return L"\\\\?\\" + absolute;
}

std::wstring finalPathForHandle(HANDLE handle) {
  DWORD required = GetFinalPathNameByHandleW(
    handle,
    nullptr,
    0,
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
  );
  if (required == 0) throw std::runtime_error("Unable to resolve the opened filesystem handle.");

  std::vector<wchar_t> buffer(required + 1);
  DWORD written = GetFinalPathNameByHandleW(
    handle,
    buffer.data(),
    static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
  );
  if (written == 0 || written >= buffer.size()) {
    throw std::runtime_error("Unable to resolve the opened filesystem handle.");
  }

  std::wstring result(buffer.data(), written);
  std::replace(result.begin(), result.end(), L'/', L'\\');
  while (result.size() > 4 && result.back() == L'\\') result.pop_back();
  return result;
}

bool pathIsWithin(const std::wstring& root, const std::wstring& candidate) {
  if (candidate.size() < root.size() ||
      _wcsnicmp(root.c_str(), candidate.c_str(), root.size()) != 0) {
    return false;
  }
  if (candidate.size() == root.size()) return true;
  return candidate[root.size()] == L'\\';
}

void throwLastError(const char* operation) {
  DWORD code = GetLastError();
  throw std::runtime_error(
    std::string(operation) + " failed with Windows error " + std::to_string(code) + "."
  );
}

FILE_STANDARD_INFO standardInfo(HANDLE handle) {
  FILE_STANDARD_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &info, sizeof(info))) {
    throwLastError("Reading file type and size");
  }
  return info;
}

FILE_BASIC_INFO basicInfo(HANDLE handle) {
  FILE_BASIC_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info))) {
    throwLastError("Reading file timestamps");
  }
  return info;
}

void rejectReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) {
    throwLastError("Reading reparse-point attributes");
  }
  if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw std::runtime_error("Reparse-point paths are not permitted beneath the configured root.");
  }
}

RootContext openRoot(const std::wstring& configuredRoot) {
  Handle handle(CreateFileW(
    toExtendedPath(configuredRoot).c_str(),
    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    nullptr
  ));
  if (!handle.valid()) throwLastError("Opening the configured root directory");

  FILE_STANDARD_INFO info = standardInfo(handle.get());
  if (!info.Directory) throw std::runtime_error("The configured root is not a directory.");

  RootContext root{std::move(handle), L""};
  root.canonicalPath = finalPathForHandle(root.handle.get());
  return root;
}

Handle openValidatedTarget(
  const RootContext& root,
  const std::wstring& requestedPath,
  DWORD desiredAccess,
  bool expectDirectory,
  bool allowRoot = false
) {
  const DWORD flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
  Handle handle(CreateFileW(
    toExtendedPath(requestedPath).c_str(),
    desiredAccess,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr,
    OPEN_EXISTING,
    flags,
    nullptr
  ));
  if (!handle.valid()) throwLastError("Opening a path beneath the configured root");

  rejectReparsePoint(handle.get());
  FILE_STANDARD_INFO standard = standardInfo(handle.get());
  if (standard.Directory != expectDirectory) {
    throw std::runtime_error(expectDirectory
      ? "The requested path is not a directory."
      : "The requested path is not a regular file.");
  }

  std::wstring canonicalTarget = finalPathForHandle(handle.get());
  if (!pathIsWithin(root.canonicalPath, canonicalTarget) ||
      (!allowRoot && _wcsicmp(root.canonicalPath.c_str(), canonicalTarget.c_str()) == 0)) {
    throw std::runtime_error("The opened path resolves outside the configured root.");
  }
  return handle;
}

double fileTimeToUnixMs(LARGE_INTEGER fileTime) {
  return static_cast<double>(fileTime.QuadPart) / 10000.0 - 11644473600000.0;
}

template <typename Callback>
void enumerateDirectory(HANDLE directory, Callback callback) {
  std::vector<unsigned char> buffer(64 * 1024);
  bool restart = true;
  for (;;) {
    FILE_INFO_BY_HANDLE_CLASS infoClass = restart
      ? FileIdBothDirectoryRestartInfo
      : FileIdBothDirectoryInfo;
    restart = false;

    if (!GetFileInformationByHandleEx(
          directory,
          infoClass,
          buffer.data(),
          static_cast<DWORD>(buffer.size()))) {
      DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_FILES || error == ERROR_HANDLE_EOF) return;
      SetLastError(error);
      throwLastError("Enumerating an opened directory handle");
    }

    size_t offset = 0;
    for (;;) {
      if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size()) {
        throw std::runtime_error("The filesystem returned a malformed directory entry.");
      }
      auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      if (entry->FileNameLength % sizeof(WCHAR) != 0 ||
          offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + entry->FileNameLength > buffer.size()) {
        throw std::runtime_error("The filesystem returned a malformed directory name.");
      }

      std::wstring name(entry->FileName, entry->FileNameLength / sizeof(WCHAR));
      if (name != L"." && name != L".." &&
          (entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
          (entry->FileAttributes & FILE_ATTRIBUTE_DEVICE) == 0) {
        DirectoryEntry item{
          name,
          (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
          entry->EndOfFile.QuadPart < 0 ? 0 : static_cast<uint64_t>(entry->EndOfFile.QuadPart),
          fileTimeToUnixMs(entry->LastWriteTime)
        };
        callback(item);
      }

      if (entry->NextEntryOffset == 0) break;
      if (entry->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
          offset + entry->NextEntryOffset >= buffer.size()) {
        throw std::runtime_error("The filesystem returned an invalid directory-entry offset.");
      }
      offset += entry->NextEntryOffset;
    }
  }
}

std::vector<DirectoryEntry> readDirectoryEntries(HANDLE directory) {
  std::vector<DirectoryEntry> entries;
  enumerateDirectory(directory, [&entries](const DirectoryEntry& entry) {
    entries.push_back(entry);
  });
  return entries;
}

size_t countDirectoryEntries(HANDLE directory) {
  size_t count = 0;
  enumerateDirectory(directory, [&count](const DirectoryEntry&) {
    ++count;
  });
  return count;
}

napi_value createNumber(napi_env env, double value) {
  napi_value result;
  if (napi_create_double(env, value, &result) != napi_ok) {
    throw std::runtime_error("Unable to create a numeric result.");
  }
  return result;
}

napi_value createBoolean(napi_env env, bool value) {
  napi_value result;
  if (napi_get_boolean(env, value, &result) != napi_ok) {
    throw std::runtime_error("Unable to create a boolean result.");
  }
  return result;
}

void setProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  if (napi_set_named_property(env, object, name, value) != napi_ok) {
    throw std::runtime_error("Unable to create a native filesystem result.");
  }
}

void throwJsError(napi_env env, const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
}

napi_value openRegularFile(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args = arguments(env, info, 3);
    if (args.size() < 2) throw std::runtime_error("Expected configured root and file path.");

    std::wstring configuredRoot = valueToWide(env, args[0]);
    std::wstring requestedPath = valueToWide(env, args[1]);
    RootContext root = openRoot(configuredRoot);
    Handle file = openValidatedTarget(
      root,
      requestedPath,
      GENERIC_READ | FILE_READ_ATTRIBUTES,
      false
    );
    callOptionalHook(env, args, 2);

    int descriptor = _open_osfhandle(
      reinterpret_cast<intptr_t>(file.get()),
      _O_RDONLY | _O_BINARY
    );
    if (descriptor < 0) throw std::runtime_error("Unable to convert the verified Windows file handle.");
    file.release();

    napi_value result;
    if (napi_create_int32(env, descriptor, &result) != napi_ok) {
      _close(descriptor);
      throw std::runtime_error("Unable to return the verified Windows file handle.");
    }
    return result;
  } catch (const std::exception& error) {
    throwJsError(env, error);
    return nullptr;
  }
}

napi_value readDirectory(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args = arguments(env, info, 3);
    if (args.size() < 2) throw std::runtime_error("Expected configured root and directory path.");

    std::wstring configuredRoot = valueToWide(env, args[0]);
    std::wstring requestedPath = valueToWide(env, args[1]);
    RootContext root = openRoot(configuredRoot);
    Handle directory = openValidatedTarget(
      root,
      requestedPath,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      true,
      true
    );
    callOptionalHook(env, args, 2);

    std::vector<DirectoryEntry> entries = readDirectoryEntries(directory.get());
    napi_value result;
    napi_value array;
    if (napi_create_object(env, &result) != napi_ok ||
        napi_create_array_with_length(env, entries.size(), &array) != napi_ok) {
      throw std::runtime_error("Unable to create a directory-list result.");
    }
    setProperty(env, result, "canonicalRoot", wideToValue(env, root.canonicalPath));

    for (size_t index = 0; index < entries.size(); ++index) {
      const DirectoryEntry& entry = entries[index];
      napi_value item;
      if (napi_create_object(env, &item) != napi_ok) {
        throw std::runtime_error("Unable to create a directory-entry result.");
      }
      setProperty(env, item, "name", wideToValue(env, entry.name));
      setProperty(env, item, "isDirectory", createBoolean(env, entry.isDirectory));
      setProperty(env, item, "sizeBytes", createNumber(env, static_cast<double>(entry.sizeBytes)));
      setProperty(env, item, "modifiedAtMs", createNumber(env, entry.modifiedAtMs));

      napi_value fileCount = nullptr;
      if (entry.isDirectory) {
        try {
          std::wstring childPath = finalPathForHandle(directory.get()) + L"\\" + entry.name;
          Handle child = openValidatedTarget(
            root,
            childPath,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            true
          );
          fileCount = createNumber(env, static_cast<double>(countDirectoryEntries(child.get())));
        } catch (...) {
          napi_get_null(env, &fileCount);
        }
      } else {
        napi_get_null(env, &fileCount);
      }
      setProperty(env, item, "fileCount", fileCount);
      if (napi_set_element(env, array, static_cast<uint32_t>(index), item) != napi_ok) {
        throw std::runtime_error("Unable to append a directory-entry result.");
      }
    }
    setProperty(env, result, "entries", array);
    return result;
  } catch (const std::exception& error) {
    throwJsError(env, error);
    return nullptr;
  }
}

napi_value removeEmptyDirectory(napi_env env, napi_callback_info info) {
  try {
    std::vector<napi_value> args = arguments(env, info, 3);
    if (args.size() < 2) throw std::runtime_error("Expected configured root and directory path.");

    std::wstring configuredRoot = valueToWide(env, args[0]);
    std::wstring requestedPath = valueToWide(env, args[1]);
    RootContext root = openRoot(configuredRoot);
    Handle directory = openValidatedTarget(
      root,
      requestedPath,
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      true
    );
    callOptionalHook(env, args, 2);

    if (countDirectoryEntries(directory.get()) != 0) return createBoolean(env, false);

    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(
          directory.get(),
          FileDispositionInfo,
          &disposition,
          sizeof(disposition))) {
      DWORD error = GetLastError();
      if (error == ERROR_DIR_NOT_EMPTY) return createBoolean(env, false);
      SetLastError(error);
      throwLastError("Removing the verified empty directory handle");
    }
    return createBoolean(env, true);
  } catch (const std::exception& error) {
    throwJsError(env, error);
    return nullptr;
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "openRegularFile", nullptr, openRegularFile, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "readDirectory", nullptr, readDirectory, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "removeEmptyDirectory", nullptr, removeEmptyDirectory, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

#else

static napi_value unsupported(napi_env env, napi_callback_info) {
  napi_throw_error(env, nullptr, "The native safe-filesystem helper is only available on Windows.");
  return nullptr;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "openRegularFile", nullptr, unsupported, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "readDirectory", nullptr, unsupported, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "removeEmptyDirectory", nullptr, unsupported, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

#endif
