#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>

#define TEMPORARY_NAME_PREFIX "switchboard-sidecar-tmp-"
#define TEMPORARY_NAME_PREFIX_LENGTH (sizeof(TEMPORARY_NAME_PREFIX) - 1)

static napi_value throw_publish_error(napi_env env, const char *code,
                                      const char *message) {
  napi_value error;
  napi_value code_value;
  napi_value message_value;

  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) !=
          napi_ok ||
      napi_create_error(env, NULL, message_value, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) !=
          napi_ok ||
      napi_set_named_property(env, error, "code", code_value) != napi_ok) {
    napi_throw_error(env, NULL, "Atomic publish failed.");
    return NULL;
  }

  napi_throw(env, error);
  return NULL;
}

static int value_to_utf8(napi_env env, napi_value value, char **output,
                         size_t *output_length) {
  size_t length = 0;
  size_t copied = 0;

  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length >= PATH_MAX) {
    return 0;
  }

  *output = malloc(length + 1);
  if (*output == NULL) {
    return -1;
  }

  if (napi_get_value_string_utf8(env, value, *output, length + 1, &copied) !=
          napi_ok ||
      copied != length || memchr(*output, '\0', length) != NULL) {
    free(*output);
    *output = NULL;
    return 0;
  }

  *output_length = length;
  return 1;
}

static int is_valid_basename(const char *name, size_t length) {
  size_t index;

  if (length == 0 || length > 128 ||
      (length == 1 && name[0] == '.') ||
      (length == 2 && name[0] == '.' && name[1] == '.')) {
    return 0;
  }

  for (index = 0; index < length; index += 1) {
    unsigned char character = (unsigned char)name[index];
    if ((index == 0 &&
         !((character >= 'A' && character <= 'Z') ||
           (character >= 'a' && character <= 'z') ||
           (character >= '0' && character <= '9'))) ||
        !((character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == '-')) {
      return 0;
    }
  }

  return 1;
}

static int is_valid_temporary_basename(const char *name, size_t length) {
  return is_valid_basename(name, length) &&
         length > TEMPORARY_NAME_PREFIX_LENGTH &&
         memcmp(name, TEMPORARY_NAME_PREFIX, TEMPORARY_NAME_PREFIX_LENGTH) == 0;
}

static int is_canonical_absolute_parent(const char *parent, size_t length) {
  size_t component_start;
  size_t index;

  if (length < 2 || parent[0] != '/' || parent[length - 1] == '/') {
    return 0;
  }

  component_start = 1;
  for (index = 1; index <= length; index += 1) {
    if (index == length || parent[index] == '/') {
      size_t component_length = index - component_start;
      if (component_length == 0 ||
          (component_length == 1 && parent[component_start] == '.') ||
          (component_length == 2 && parent[component_start] == '.' &&
           parent[component_start + 1] == '.')) {
        return 0;
      }
      component_start = index + 1;
    }
  }

  return 1;
}

static int open_canonical_parent(char *parent) {
  int current_fd = -1;
  char *component = parent + 1;
  char *separator;

  current_fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current_fd < 0) {
    return -1;
  }

  while (component[0] != '\0') {
    int next_fd;
    separator = strchr(component, '/');
    if (separator != NULL) {
      *separator = '\0';
    }

    next_fd = openat(current_fd, component,
                     O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (separator != NULL) {
      *separator = '/';
    }
    if (next_fd < 0) {
      close(current_fd);
      return -1;
    }
    close(current_fd);
    current_fd = next_fd;

    if (separator == NULL) {
      break;
    }
    component = separator + 1;
  }

  return current_fd;
}

struct volume_capability_buffer {
  uint32_t length;
  vol_capabilities_attr_t capabilities;
};

static int volume_supports_exclusive_rename(int parent_fd) {
#if defined(ATOMIC_PUBLISH_FORCE_UNSUPPORTED_VOLUME)
  (void)parent_fd;
  return 0;
#else
  struct attrlist attributes;
  struct volume_capability_buffer buffer;

  memset(&attributes, 0, sizeof(attributes));
  memset(&buffer, 0, sizeof(buffer));
  attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
  attributes.volattr = ATTR_VOL_CAPABILITIES;

  if (fgetattrlist(parent_fd, &attributes, &buffer, sizeof(buffer),
                   0) != 0) {
    return 0;
  }

  if (buffer.length < sizeof(buffer)) {
    return 0;
  }

  return (buffer.capabilities.valid[VOL_CAPABILITIES_INTERFACES] &
          VOL_CAP_INT_RENAME_EXCL) != 0 &&
         (buffer.capabilities.capabilities[VOL_CAPABILITIES_INTERFACES] &
          VOL_CAP_INT_RENAME_EXCL) != 0;
#endif
}

static napi_value atomic_publish(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  size_t argument_count = 3;
  napi_valuetype argument_type;
  char *parent = NULL;
  char *temporary_name = NULL;
  char *final_name = NULL;
  size_t parent_length = 0;
  size_t temporary_length = 0;
  size_t final_length = 0;
  int parent_fd = -1;
  struct stat source_status;
  int rename_error;
  napi_value undefined;

  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) !=
          napi_ok ||
      argument_count != 3) {
    return throw_publish_error(env, "INVALID_ARGUMENT",
                               "Atomic publish rejected invalid input.");
  }

  for (size_t index = 0; index < 3; index += 1) {
    if (napi_typeof(env, arguments[index], &argument_type) != napi_ok ||
        argument_type != napi_string) {
      return throw_publish_error(env, "INVALID_ARGUMENT",
                                 "Atomic publish rejected invalid input.");
    }
  }

  int parent_result = value_to_utf8(env, arguments[0], &parent, &parent_length);
  int temporary_result =
      value_to_utf8(env, arguments[1], &temporary_name, &temporary_length);
  int final_result = value_to_utf8(env, arguments[2], &final_name, &final_length);
  if (parent_result <= 0 || temporary_result <= 0 || final_result <= 0) {
    free(parent);
    free(temporary_name);
    free(final_name);
    if (parent_result < 0 || temporary_result < 0 || final_result < 0) {
      return throw_publish_error(env, "PUBLISH_FAILED", "Atomic publish failed.");
    }
    return throw_publish_error(env, "INVALID_ARGUMENT",
                               "Atomic publish rejected invalid input.");
  }

  if (!is_canonical_absolute_parent(parent, parent_length) ||
      !is_valid_temporary_basename(temporary_name, temporary_length) ||
      !is_valid_basename(final_name, final_length) ||
      strcmp(temporary_name, final_name) == 0) {
    free(parent);
    free(temporary_name);
    free(final_name);
    return throw_publish_error(env, "INVALID_ARGUMENT",
                               "Atomic publish rejected invalid input.");
  }

  parent_fd = open_canonical_parent(parent);
  if (parent_fd < 0) {
    free(parent);
    free(temporary_name);
    free(final_name);
    return throw_publish_error(env, "UNSAFE_PARENT",
                               "Atomic publish rejected the destination parent.");
  }

  {
    struct stat parent_status;
    if (fstat(parent_fd, &parent_status) != 0 || !S_ISDIR(parent_status.st_mode) ||
        parent_status.st_uid != geteuid() ||
        (parent_status.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
      close(parent_fd);
      free(parent);
      free(temporary_name);
      free(final_name);
      return throw_publish_error(env, "UNSAFE_PARENT",
                                 "Atomic publish rejected the destination parent.");
    }
  }

  if (!volume_supports_exclusive_rename(parent_fd)) {
    close(parent_fd);
    free(parent);
    free(temporary_name);
    free(final_name);
    return throw_publish_error(env, "UNSUPPORTED_VOLUME",
                               "Atomic publish requires exclusive rename support.");
  }

  if (fstatat(parent_fd, temporary_name, &source_status, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      !S_ISDIR(source_status.st_mode) || source_status.st_uid != geteuid() ||
      (source_status.st_mode & 07777) != 0700) {
    close(parent_fd);
    free(parent);
    free(temporary_name);
    free(final_name);
    return throw_publish_error(env, "INVALID_SOURCE",
                               "Atomic publish rejected the source directory.");
  }

  if (renameatx_np(parent_fd, temporary_name, parent_fd, final_name,
                   RENAME_EXCL | RENAME_NOFOLLOW_ANY) == 0) {
    close(parent_fd);
    free(parent);
    free(temporary_name);
    free(final_name);
    if (napi_get_undefined(env, &undefined) != napi_ok) {
      napi_throw_error(env, NULL, "Atomic publish failed.");
      return NULL;
    }
    return undefined;
  }
  rename_error = errno;

  close(parent_fd);
  free(parent);
  free(temporary_name);
  free(final_name);

  if (rename_error == EEXIST || rename_error == ENOTEMPTY) {
    return throw_publish_error(env, "DESTINATION_EXISTS",
                               "The publish destination already exists.");
  }
  if (rename_error == ENOENT || rename_error == ENOTDIR || rename_error == ELOOP) {
    return throw_publish_error(env, "INVALID_SOURCE",
                               "Atomic publish rejected the source directory.");
  }
  return throw_publish_error(env, "PUBLISH_FAILED", "Atomic publish failed.");
}

NAPI_MODULE_INIT() {
  napi_value publish;
  if (napi_create_function(env, "atomicPublish", NAPI_AUTO_LENGTH,
                           atomic_publish, NULL, &publish) != napi_ok ||
      napi_set_named_property(env, exports, "atomicPublish", publish) !=
          napi_ok) {
    napi_throw_error(env, NULL, "Atomic publish addon initialization failed.");
    return NULL;
  }
  return exports;
}
