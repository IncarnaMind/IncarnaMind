#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

int run_call_watcher(HKEY root);

int wmain(int argc, WCHAR **argv) {
    const WCHAR prefix[] = L"Software\\IncarnaMind\\Tests\\CallWatcher-";
    if (argc != 2 || wcsncmp(argv[1], prefix, ARRAYSIZE(prefix) - 1) != 0) return 1;
    HKEY root;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, argv[1], 0, KEY_READ, &root) != ERROR_SUCCESS) return 1;
    int result = run_call_watcher(root);
    RegCloseKey(root);
    return result;
}
