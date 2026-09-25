/*
 * A future quiescent export needs a bounded inventory that cannot follow a
 * swapped symlink outside its opened root descriptor. Ancestor aliases are
 * canonicalized before open; the caller must attest that canonical source
 * identity and boundary. This helper does not certify a coherent export.
 */
#define _DARWIN_C_SOURCE 1
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_NOFOLLOW_ANY
#error "This helper requires macOS O_NOFOLLOW_ANY for the root path."
#endif

enum {
  MAX_ITEMS = 10000,
  MAX_DEPTH = 32,
  MAX_PATH_BYTES = 2048,
  CHUNK_BYTES = 65536
};
static const uint64_t MAX_TOTAL_BYTES = 64ull * 1024ull * 1024ull;

typedef struct {
  char *path;
  char kind;
  uint64_t bytes;
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
} Item;

static Item *items;
static size_t item_count;
static uint64_t total_bytes;
static dev_t root_device;
static const char *refusal = "unsafe or changing tree";

#ifdef R24_INVENTORY_TESTING
/* Deterministic race seam exists only in test builds. */
static void pause_before_open(const char *relative) {
  const char *wanted = getenv("R24_TEST_PAUSE_BEFORE_OPEN");
  if (wanted != NULL && strcmp(wanted, relative) == 0) {
    fputs("R24_TEST_PAUSED\n", stderr);
    fflush(stderr);
    if (getchar() == EOF) _exit(90);
  }
}
#endif

static int same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
    a->st_size == b->st_size &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
    a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
    a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

static int name_order(const void *left, const void *right) {
  const char *const *a = left;
  const char *const *b = right;
  return strcmp(*a, *b);
}

static int item_order(const void *left, const void *right) {
  const Item *a = left;
  const Item *b = right;
  return strcmp(a->path, b->path);
}

static int add_item(char *path, char kind, uint64_t bytes,
                    const unsigned char *hash) {
  if (item_count >= MAX_ITEMS) {
    refusal = "item limit";
    return -1;
  }
  Item *item = &items[item_count++];
  item->path = path;
  item->kind = kind;
  item->bytes = bytes;
  if (hash != NULL) memcpy(item->hash, hash, sizeof(item->hash));
  return 0;
}

static int hash_regular_file(int fd, const struct stat *opened,
                             unsigned char output[CC_SHA256_DIGEST_LENGTH]) {
  if (!S_ISREG(opened->st_mode) || opened->st_nlink != 1 ||
      opened->st_size < 0 ||
      (uint64_t)opened->st_size > MAX_TOTAL_BYTES - total_bytes) {
    refusal = "linked, unsupported, or oversized file";
    return -1;
  }
  CC_SHA256_CTX digest;
  if (CC_SHA256_Init(&digest) != 1) {
    refusal = "digest initialization";
    return -1;
  }
  unsigned char chunk[CHUNK_BYTES];
  uint64_t read_bytes = 0;
  for (;;) {
    ssize_t count = read(fd, chunk, sizeof(chunk));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      refusal = "file read";
      return -1;
    }
    if (count == 0) break;
    if ((uint64_t)count > (uint64_t)opened->st_size - read_bytes ||
        CC_SHA256_Update(&digest, chunk, (CC_LONG)count) != 1) {
      refusal = "file changed while hashing";
      return -1;
    }
    read_bytes += (uint64_t)count;
  }
  struct stat after;
  if (fstat(fd, &after) != 0 || read_bytes != (uint64_t)opened->st_size ||
      !same_identity(opened, &after) || CC_SHA256_Final(output, &digest) != 1) {
    refusal = "file changed while hashing";
    return -1;
  }
  total_bytes += read_bytes;
  return 0;
}

static char *child_path(const char *prefix, const char *name) {
  size_t prefix_length = strlen(prefix);
  size_t name_length = strlen(name);
  size_t length = prefix_length + (prefix_length ? 1 : 0) + name_length;
  if (length == 0 || length > MAX_PATH_BYTES || strchr(name, '/') != NULL) {
    refusal = "path bound or unsafe name";
    return NULL;
  }
  char *result = malloc(length + 1);
  if (result == NULL) {
    refusal = "allocation";
    return NULL;
  }
  memcpy(result, prefix, prefix_length);
  if (prefix_length) result[prefix_length] = '/';
  memcpy(result + prefix_length + (prefix_length ? 1 : 0), name, name_length);
  result[length] = '\0';
  return result;
}

static int scan_directory(int fd, const char *prefix, unsigned depth) {
  if (depth > MAX_DEPTH) {
    refusal = "depth limit";
    return -1;
  }
  struct stat before, after;
  if (fstat(fd, &before) != 0 || !S_ISDIR(before.st_mode)) {
    refusal = "directory descriptor";
    return -1;
  }
  int listing_fd = dup(fd);
  if (listing_fd < 0) {
    refusal = "directory descriptor";
    return -1;
  }
  DIR *dir = fdopendir(listing_fd);
  if (dir == NULL) {
    close(listing_fd);
    refusal = "directory listing";
    return -1;
  }
  char **names = NULL;
  size_t count = 0;
  size_t capacity = 0;
  int result = -1;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (entry == NULL) {
      if (errno != 0) refusal = "directory listing";
      else result = 0;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    if (count >= MAX_ITEMS) {
      refusal = "item limit";
      break;
    }
    if (capacity == count) {
      size_t next_capacity = capacity ? capacity * 2 : 16;
      char **grown = realloc(names, next_capacity * sizeof(*names));
      if (grown == NULL) {
        refusal = "allocation";
        break;
      }
      names = grown;
      capacity = next_capacity;
    }
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      refusal = "allocation";
      break;
    }
    count++;
  }
  if (closedir(dir) != 0) {
    refusal = "directory listing";
    result = -1;
  }
  if (result == 0 && (fstat(fd, &after) != 0 ||
                      !same_identity(&before, &after))) {
    refusal = "directory changed while listing";
    result = -1;
  }
  if (result == 0) qsort(names, count, sizeof(*names), name_order);
  for (size_t i = 0; result == 0 && i < count; i++) {
    const char *name = names[i];
    char *relative = child_path(prefix, name);
    if (relative == NULL) {
      result = -1;
      break;
    }
    struct stat at_name, opened, final_name;
    if (fstatat(fd, name, &at_name, AT_SYMLINK_NOFOLLOW) != 0 ||
        S_ISLNK(at_name.st_mode) || at_name.st_dev != root_device) {
      refusal = "linked or changing entry";
      free(relative);
      result = -1;
      break;
    }
#ifdef R24_INVENTORY_TESTING
    pause_before_open(relative);
#endif
    if (S_ISDIR(at_name.st_mode)) {
      int child = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW |
                        O_NONBLOCK | O_CLOEXEC);
      if (child < 0 || fstat(child, &opened) != 0 ||
          !same_identity(&at_name, &opened)) {
        if (child >= 0) close(child);
        refusal = "linked or changing directory";
        free(relative);
        result = -1;
        break;
      }
      if (add_item(relative, 'D', 0, NULL) != 0) {
        close(child);
        free(relative);
        result = -1;
        break;
      }
      result = scan_directory(child, relative, depth + 1);
      if (fstatat(fd, name, &final_name, AT_SYMLINK_NOFOLLOW) != 0 ||
          !same_identity(&opened, &final_name)) {
        refusal = "directory changed after listing";
        result = -1;
      }
      close(child);
    } else if (S_ISREG(at_name.st_mode)) {
      int child = openat(fd, name, O_RDONLY | O_NOFOLLOW |
                        O_NONBLOCK | O_CLOEXEC);
      if (child < 0 || fstat(child, &opened) != 0 ||
          !same_identity(&at_name, &opened)) {
        if (child >= 0) close(child);
        refusal = "linked or changing file";
        free(relative);
        result = -1;
        break;
      }
      unsigned char hash[CC_SHA256_DIGEST_LENGTH];
      result = hash_regular_file(child, &opened, hash);
      if (fstatat(fd, name, &final_name, AT_SYMLINK_NOFOLLOW) != 0 ||
          !same_identity(&opened, &final_name)) {
        refusal = "file changed after hashing";
        result = -1;
      }
      close(child);
      if (result == 0 &&
          add_item(relative, 'F', (uint64_t)opened.st_size, hash) != 0)
        result = -1;
      if (result != 0) free(relative);
    } else {
      refusal = "unsupported entry type";
      free(relative);
      result = -1;
    }
  }
  if (result == 0 && (fstat(fd, &after) != 0 ||
                      !same_identity(&before, &after))) {
    refusal = "directory changed while scanning";
    result = -1;
  }
  for (size_t i = 0; i < count; i++) free(names[i]);
  free(names);
  return result;
}

static void print_hex(const unsigned char *data, size_t length) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i++) {
    putchar(alphabet[data[i] >> 4]);
    putchar(alphabet[data[i] & 15]);
  }
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fputs("usage: r24-inventory ROOT\n", stderr);
    return 2;
  }
  items = calloc(MAX_ITEMS, sizeof(*items));
  if (items == NULL) {
    fputs("r24 inventory refused: allocation\n", stderr);
    return 1;
  }
  struct stat spelled_before, opened, spelled_after;
  int root_fd = -1;
  char *canonical = NULL;
  int result = -1;
  if (lstat(argv[1], &spelled_before) != 0 ||
      !S_ISDIR(spelled_before.st_mode) ||
      S_ISLNK(spelled_before.st_mode)) {
    refusal = "missing or linked root";
    goto done;
  }
  /* Resolve ancestor aliases, then pin the canonical inode without symlinks. */
  canonical = realpath(argv[1], NULL);
  if (canonical == NULL) {
    refusal = "root resolution";
    goto done;
  }
  root_fd = open(canonical, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY |
                           O_CLOEXEC);
  if (root_fd < 0 || fstat(root_fd, &opened) != 0 ||
      !same_identity(&spelled_before, &opened)) {
    refusal = "root changed before open";
    goto done;
  }
  root_device = opened.st_dev;
  result = scan_directory(root_fd, "", 0);
  if (result == 0 &&
      (lstat(argv[1], &spelled_after) != 0 ||
       !same_identity(&opened, &spelled_after) ||
       fstat(root_fd, &spelled_after) != 0 ||
       !same_identity(&opened, &spelled_after))) {
    refusal = "root changed during inventory";
    result = -1;
  }
done:
  if (root_fd >= 0) close(root_fd);
  free(canonical);
  if (result == 0) {
    qsort(items, item_count, sizeof(*items), item_order);
    puts("R24-NOFOLLOW-INVENTORY\t1");
    for (size_t i = 0; i < item_count; i++) {
      Item *item = &items[i];
      printf("%c\t", item->kind);
      print_hex((const unsigned char *)item->path, strlen(item->path));
      if (item->kind == 'F') {
        printf("\t%" PRIu64 "\t", item->bytes);
        print_hex(item->hash, sizeof(item->hash));
      }
      putchar('\n');
    }
    if (fflush(stdout) != 0) result = -1;
  } else {
    fprintf(stderr, "r24 inventory refused: %s\n", refusal);
  }
  for (size_t i = 0; i < item_count; i++) free(items[i].path);
  free(items);
  return result == 0 ? 0 : 1;
}
