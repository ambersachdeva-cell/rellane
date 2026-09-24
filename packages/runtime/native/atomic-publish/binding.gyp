{
  "targets": [
    {
      "target_name": "atomic_publish",
      "sources": ["src/atomic_publish.c"],
      "cflags": ["-Wall", "-Wextra", "-Werror", "-Wpedantic"],
      "xcode_settings": {
        "CLANG_C_LANGUAGE_STANDARD": "c11",
        "GCC_TREAT_WARNINGS_AS_ERRORS": "YES",
        "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES"
      }
    },
    {
      "target_name": "atomic_publish_unsupported_volume",
      "sources": ["src/atomic_publish.c"],
      "defines": ["ATOMIC_PUBLISH_FORCE_UNSUPPORTED_VOLUME=1"],
      "cflags": ["-Wall", "-Wextra", "-Werror", "-Wpedantic"],
      "xcode_settings": {
        "CLANG_C_LANGUAGE_STANDARD": "c11",
        "GCC_TREAT_WARNINGS_AS_ERRORS": "YES",
        "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES"
      }
    }
  ]
}
