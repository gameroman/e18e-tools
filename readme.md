# Simplified fork of Fuzzyma/e18e-tools for Roman's needs

```sh
bunx github:gameroman/e18e-tools#HEAD packagename -n 100
```

Flags:

- -n, --number - how many results to print
- -f, --file - write full results to a JSON file
- -e, --exclude - comma-separated substrings to exclude
- -D, --dev - use devDependencies
- -l, --list - print names only (one per line)
- -d, --depths - recursion depth (0 = no recursion)
- -r, --recursive - expand top N per level when recursing
- -a, --accumulate - accumulate downloads across subtrees
