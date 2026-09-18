# SDK release helpers. Run from repo root: make -C sdk sbom
.PHONY: sbom verify test

sbom:
	python3 scripts/make_sbom.py

verify:
	python3 scripts/make_sbom.py --verify

test:
	cd .. && PYTHONPATH=sdk/python:. python3 -m unittest tests.test_dgc_sdk
