# všetky *.test.ts okrem ess.test.ts
TESTS=$(find test -maxdepth 1 -name '*.test.ts' ! -name 'ess.test.ts' | sort | tr '\n' ' ')

echo "Séria A (bez ess):"
echo "$TESTS"

npx --yes c8@10 \
  --reporter=text \
  --reporter=text-summary \
  --include='src/**/*.ts' \
  --extension=.ts \
  node --import tsx --test $TESTS | tee /tmp/pal-domain-before.txt



# všetky *.test.ts vrátane ess.test.ts
TESTS=$(find test -maxdepth 1 -name '*.test.ts' | sort | tr '\n' ' ')

echo "Séria B (s ess):"
echo "$TESTS"

npx --yes c8@10 \
  --reporter=text \
  --reporter=text-summary \
  --include='src/**/*.ts' \
  --extension=.ts \
  node --import tsx --test $TESTS | tee /tmp/pal-domain-after.txt