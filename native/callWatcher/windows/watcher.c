#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

static BOOL absent(LSTATUS error) {
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

static LSTATUS microphone_in_use(HKEY app, BOOL *in_use) {
    ULONGLONG start = 0, end = 0;
    DWORD bytes = (DWORD)sizeof(start);
    *in_use = FALSE;
    LSTATUS status = RegGetValueW(app, NULL, L"LastUsedTimeStart", RRF_RT_REG_QWORD,
                                  NULL, &start, &bytes);
    if (status == ERROR_FILE_NOT_FOUND) return ERROR_SUCCESS;
    if (status != ERROR_SUCCESS || !start) return status;
    bytes = (DWORD)sizeof(end);
    status = RegGetValueW(app, NULL, L"LastUsedTimeStop", RRF_RT_REG_QWORD,
                          NULL, &end, &bytes);
    if (status == ERROR_FILE_NOT_FOUND) status = ERROR_SUCCESS;
    if (status == ERROR_SUCCESS) *in_use = end < start;
    return status;
}

typedef struct AppName {
    char token[256];
    struct AppName *next;
} AppName;

// A desktop key encodes the installation path with '#' separators. Only the file name leaves
// the watcher. Package family names and supported file names use this ASCII alphabet.
static LSTATUS remember_name(const WCHAR *name, AppName **apps) {
    const WCHAR *last = wcsrchr(name, L'#');
    const WCHAR *file = last ? last + 1 : name;
    char token[256];
    size_t i = 0;
    for (; file[i]; i++) {
        WCHAR c = file[i];
        if (i >= sizeof(token) - 1 || !((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
            (c >= L'0' && c <= L'9') || c == L'.' || c == L'-' || c == L'_')) return ERROR_SUCCESS;
        token[i] = (char)c;
    }
    if (!i) return ERROR_SUCCESS;
    AppName *entry = malloc(sizeof(*entry));
    if (!entry) return ERROR_NOT_ENOUGH_MEMORY;
    memcpy(entry->token, token, i);
    entry->token[i] = 0;
    entry->next = *apps;
    *apps = entry;
    return ERROR_SUCCESS;
}

static LSTATUS list_apps(HKEY parent, BOOL desktop, AppName **apps) {
    for (DWORD i = 0;; i++) {
        WCHAR name[256];
        DWORD length = ARRAYSIZE(name);
        LSTATUS status = RegEnumKeyExW(parent, i, name, &length, NULL, NULL, NULL, NULL);
        if (status == ERROR_NO_MORE_ITEMS) return ERROR_SUCCESS;
        if (status != ERROR_SUCCESS) return status;
        if (!desktop && !_wcsicmp(name, L"NonPackaged")) continue;
        HKEY app;
        status = RegOpenKeyExW(parent, name, 0, KEY_QUERY_VALUE, &app);
        if (status != ERROR_SUCCESS) return status;
        BOOL in_use;
        status = microphone_in_use(app, &in_use);
        RegCloseKey(app);
        if (status == ERROR_SUCCESS && in_use) status = remember_name(name, apps);
        if (status != ERROR_SUCCESS) return status;
    }
}

static LSTATUS read_apps(HKEY root, AppName **apps) {
    HKEY mic;
    LSTATUS status = RegOpenKeyExW(root, MICROPHONE, 0, KEY_ENUMERATE_SUB_KEYS, &mic);
    if (status != ERROR_SUCCESS) return absent(status) ? ERROR_SUCCESS : status;
    status = list_apps(mic, FALSE, apps);
    if (status == ERROR_SUCCESS) {
        HKEY desktop;
        status = RegOpenKeyExW(mic, L"NonPackaged", 0, KEY_ENUMERATE_SUB_KEYS, &desktop);
        if (status == ERROR_SUCCESS) {
            status = list_apps(desktop, TRUE, apps);
            RegCloseKey(desktop);
        } else if (absent(status)) status = ERROR_SUCCESS;
    }
    RegCloseKey(mic);
    return status;
}

static LSTATUS snapshot(HKEY root) {
    AppName *apps = NULL;
    LSTATUS status = read_apps(root, &apps);
    BOOL exact = status == ERROR_SUCCESS;
    fputs(exact ? "{\"exact\":true,\"apps\":[" : "{\"exact\":false,\"apps\":[", stdout);
    BOOL first = TRUE;
    while (apps) {
        if (exact) printf("%s\"%s\"", first ? "" : ",", apps->token);
        first = FALSE;
        AppName *entry = apps;
        apps = entry->next;
        free(entry);
    }
    puts("]}");
    if (!exact && !absent(status) && status != ERROR_KEY_DELETED) fprintf(stderr, "Microphone registry read failed (%ld)\n", status);
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
        if (!absent(status) && status != ERROR_KEY_DELETED) return status;
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
