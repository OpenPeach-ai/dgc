# SDK release helpers. Run from repo root: make -C sdk sbom
.PHONY: sbom verify test

sbom:
	python3 scripts/make_sbom.py

verify:
	python3 scripts/make_sbom.py --verify

test:
	cd .. && PYTHONPATH=sdk/python:. python3 -m unittest tests.test_dgc_sdk tests.test_sdk_examples tests.test_sdk_packaging
	cd .. && node --experimental-strip-types --test tests/test_dgc_sdk_ts.mjs tests/test_dgc_sdk_ts_package.mjs
