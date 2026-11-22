#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define CONSENT L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore"
#define MICROPHONE CONSENT L"\\microphone"

static DWORD WINAPI wait_for_eof(void *stop) {
    char buffer[128];
    DWORD count;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(input, buffer, (DWORD)sizeof(buffer), &count, NULL) && count) {}
    SetEvent((HANDLE)stop);
    return 0;
}

static BOOL missing(LSTATUS error) {
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_KEY_DELETED;
}

static BOOL active(HKEY app) {
    ULONGLONG start = 0, end = 0;
    DWORD bytes = (DWORD)sizeof(start);
    if (RegGetValueW(app, NULL, L"LastUsedTimeStart", RRF_RT_REG_QWORD,
                     NULL, &start, &bytes) != ERROR_SUCCESS || !start) return FALSE;
    bytes = (DWORD)sizeof(end);
    LSTATUS status = RegGetValueW(app, NULL, L"LastUsedTimeStop", RRF_RT_REG_QWORD,
                                  NULL, &end, &bytes);
    return status == ERROR_FILE_NOT_FOUND || (status == ERROR_SUCCESS && (!end || end < start));
}

// Only the ASCII executable name or package family can match a supported app. A desktop
// registry key encodes the user's whole installation path with '#' separators.
static void write_name(const WCHAR *name, BOOL *first) {
    const WCHAR *last = wcsrchr(name, L'#');
    const WCHAR *file = last ? last + 1 : name;
    char token[256];
    size_t i = 0;
    for (; file[i]; i++) {
        WCHAR c = file[i];
        if (i >= sizeof(token) - 1 || !((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
            (c >= L'0' && c <= L'9') || c == L'.' || c == L'-' || c == L'_')) return;
        token[i] = (char)c;
    }
    if (!i) return;
    token[i] = 0;
    printf("%s\"%s\"", *first ? "" : ",", token);
    *first = FALSE;
}

static LSTATUS list_apps(HKEY parent, BOOL desktop, BOOL *first) {
    for (DWORD i = 0;; i++) {
        WCHAR name[256];
        DWORD length = ARRAYSIZE(name);
        LSTATUS status = RegEnumKeyExW(parent, i, name, &length, NULL, NULL, NULL, NULL);
        if (status == ERROR_NO_MORE_ITEMS || missing(status)) return ERROR_SUCCESS;
        if (status != ERROR_SUCCESS) return status;
        if (!desktop && !_wcsicmp(name, L"NonPackaged")) continue;
        HKEY app;
        status = RegOpenKeyExW(parent, name, 0, KEY_QUERY_VALUE, &app);
        if (missing(status)) continue;
        if (status != ERROR_SUCCESS) return status;
        if (active(app)) write_name(name, first);
        RegCloseKey(app);
    }
}

static LSTATUS snapshot(HKEY root) {
    HKEY mic;
    BOOL first = TRUE;
    LSTATUS status = RegOpenKeyExW(root, MICROPHONE, 0, KEY_ENUMERATE_SUB_KEYS, &mic);
    if (status != ERROR_SUCCESS && !missing(status)) return status;
    fputs("{\"exact\":true,\"apps\":[", stdout);
    if (status == ERROR_SUCCESS) {
        status = list_apps(mic, FALSE, &first);
        if (status == ERROR_SUCCESS) {
            HKEY desktop;
            status = RegOpenKeyExW(mic, L"NonPackaged", 0, KEY_ENUMERATE_SUB_KEYS, &desktop);
            if (status == ERROR_SUCCESS) {
                status = list_apps(desktop, TRUE, &first);
                RegCloseKey(desktop);
            } else if (missing(status)) status = ERROR_SUCCESS;
        }
        RegCloseKey(mic);
        if (status != ERROR_SUCCESS) return status;
    }
    puts("]}");
    return fflush(stdout) == 0 ? ERROR_SUCCESS : ERROR_WRITE_FAULT;
}

// Arm before reading so changes made during the snapshot wake the next read. On a new
// profile watch the nearest existing parent until Windows creates the microphone key.
static LSTATUS arm(HKEY root, HANDLE changed, HKEY *watched) {
    WCHAR path[] = MICROPHONE;
    while (TRUE) {
        LSTATUS status = RegOpenKeyExW(root, path, 0, KEY_NOTIFY, watched);
        if (status == ERROR_SUCCESS) {
            status = RegNotifyChangeKeyValue(*watched, TRUE, REG_NOTIFY_CHANGE_NAME |
                      REG_NOTIFY_CHANGE_LAST_SET, changed, TRUE);
            if (status == ERROR_SUCCESS) return status;
            RegCloseKey(*watched);
        }
        if (!missing(status)) return status;
        WCHAR *last = wcsrchr(path, L'\\');
        if (!last) return status;
        *last = 0;
    }
}

int run_call_watcher(HKEY root) {
    HANDLE stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    HANDLE changed = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!stop || !changed) return 1;
    HANDLE reader = CreateThread(NULL, 0, wait_for_eof, stop, 0, NULL);
    if (!reader) return 1;
    CloseHandle(reader);
    HANDLE handles[] = {stop, changed};
    for (;;) {
        HKEY watched;
        if (arm(root, changed, &watched) != ERROR_SUCCESS) return 1;
        LSTATUS status = snapshot(root);
        DWORD event = status == ERROR_SUCCESS ? WaitForMultipleObjects(2, handles, FALSE, INFINITE) : WAIT_FAILED;
        RegCloseKey(watched);
        if (event == WAIT_OBJECT_0) return 0;
        if (event != WAIT_OBJECT_0 + 1) return 1;
        // Closing the prior registry handle can itself signal the event.
        ResetEvent(changed);
    }
}

#ifndef CALL_WATCHER_FIXTURE
int main(void) {
    return run_call_watcher(HKEY_CURRENT_USER);
}
#endif
