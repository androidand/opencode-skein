I got it to the point where it can run a full mock session

Run the server with `./src/provider/sdk/mock/run`. It will run it sandboxes to make sure it doesn't interact with the outside world unexpectedly.

Then run `bun run src/provider/sdk/mock/runner/index.ts` to drive a session and get a log

There is also `bun run src/provider/sdk/mock/runner/diff.ts` which will drive two sessions at once and compare them. This is annoying right now because you have to run two servers. This would let you compare the differences between versions though

## Coverage

I also have an experiment in `serve.test.ts` which runs the server as a bun test, which gives us access to coverage info. Run it like this:

```
bun test --coverage --coverage-reporter=lcov --timeout 0 src/provider/sdk/mock/runner/serve.test.ts
```

That will give you a `lcov.info` file. Convert it to HTML with this:

genhtml coverage/lcov.info -o coverage/html && open coverage/html/index.html