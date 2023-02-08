min := node_modules/.bin/esminify

install:
	@npm install .

release:
	@$(min) ./runtime/cube.js -o ./runtime/cube.min.js
	@$(min) ./runtime/cube-reconstruction.js -o ./runtime/cube-reconstruction.min.js
	@node ./bin/version.js

publish: release tag
	@npm publish

beta: release
	@npm publish --tag beta

doc:
	@jsdoc . -r -t ./node_modules/minami -c ./jsdoc.json

tag:
	@cat package.json | awk -F '"' '/version" *: *"/{print "v"$$4}' | xargs -I {} git tag {}

test:
	@npm run test

test-cov:
	@npm run testcov

.PHONY: \
	install release publish test test-cov tag doc beta
