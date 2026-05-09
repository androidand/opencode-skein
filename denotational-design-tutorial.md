# Denotational Design: Part 1

## The Basic Idea

Denotational design means designing an abstraction by first asking:

> What does this thing mean?

Before choosing data structures, algorithms, callbacks, queues, caches, or runtime behavior, we give each core type a simple meaning. Then we define operations in terms of that meaning.

The implementation can be clever later. The meaning should be simple now.

## API vs Implementation vs Meaning

When designing a library, there are three related but different things:

| Layer | Question | Example |
| --- | --- | --- |
| API | What can users call? | `map(signal, f)` |
| Implementation | How does it run? | subscriptions, graphs, caching |
| Denotation | What does it mean? | a value changing over time |

Most designs jump between API and implementation. Denotational design adds the missing middle: a precise meaning.

## A Tiny FRP Example

Functional Reactive Programming is a good example because it starts with a very simple denotation.

A time-varying value, often called a `Behavior`, can be understood as:

```ts
Behavior<A> = Time -> A
```

That says:

> A `Behavior<A>` means: give me a time, and I can tell you the `A` value at that time.

This does not mean the implementation literally stores an infinite function. It means this is the specification. The implementation may use events, subscriptions, incremental recomputation, dependency graphs, or caching.

## Operations Follow From Meaning

Once we know what `Behavior<A>` means, operations become easier to define.

For example, `map` transforms the value inside a behavior:

```ts
map: (A -> B) -> Behavior<A> -> Behavior<B>
```

Its meaning is:

```ts
map(f, behavior)(time) = f(behavior(time))
```

That is the whole specification.

Similarly, a constant behavior:

```ts
constant: A -> Behavior<A>
```

means:

```ts
constant(value)(time) = value
```

The definitions are simple because the denotation is simple.

## Why This Helps

Denotational design is useful because it separates essence from machinery.

It helps library users because the abstraction has a clear mental model.

It helps implementers because correctness has a target independent of implementation details.

It helps API design because awkward operations become easier to spot. If an operation has no clean meaning, it may be exposing implementation machinery instead of domain meaning.

## The Design Loop

A practical denotational design loop looks like this:

1. Name the core type.
2. Write down what values of that type mean.
3. Define each operation by how it transforms meanings.
4. Notice what laws naturally follow.
5. Choose an implementation that preserves the meaning.

The key discipline is to delay implementation concerns until after the meaning is clear.

## Denotation Is Not Implementation

A denotation can look like an implementation because it is concrete enough to write down:

```ts
Behavior<A> = Time -> A
```

But this equation is not saying that a real FRP system must store a function from every possible time to an `A` value.

It is saying that this is the model we use to understand a behavior.

The implementation might use callbacks, mutable cells, event queues, dependency graphs, caching, sampling, or incremental recomputation. Those choices are representation. The denotation is the meaning those representations must preserve.

So there are two different questions:

| Question | Answer |
| --- | --- |
| What does a behavior mean? | A function from time to value |
| How do we run it efficiently? | Some concrete representation and algorithm |

A denotation should be simple and precise. An implementation should be executable and efficient. They do not have to be the same thing.

## Operations At Two Levels

Conal Elliott describes a useful pattern:

> The meaning of each method corresponds to the same method for the meaning.

This sentence is subtle because there are three things in play:

1. An abstract type, like `Behavior<A>`.
2. A meaning type, like `Time -> A`.
3. A meaning function that translates from the abstract type to the meaning type.

For behaviors, Conal often calls the meaning function `at`:

```ts
at: Behavior<A> -> (Time -> A)
```

Read this as:

> `at(behavior)` gives the meaning of `behavior`.

So `at` is just the specific FRP name for the more general idea:

```ts
meaning: Abstract<A> -> Model<A>
```

Now we can talk about operations.

There are two versions of "the same" operation.

One operation belongs to the abstract API:

```ts
mapBehavior: (A -> B) -> Behavior<A> -> Behavior<B>
```

The other operation belongs to the semantic model:

```ts
mapFunction: (A -> B) -> (Time -> A) -> (Time -> B)
```

They are not literally the same function. They live at different levels. But they are the same conceptual operation: mapping a pure function over a value inside some structure.

The homomorphism law says that translating meanings should not care which order we take these steps.

Path 1: operate first, then take the meaning.

```ts
behavior
  -> mapBehavior(f, behavior)
  -> at(mapBehavior(f, behavior))
```

Path 2: take the meaning first, then operate on the meaning.

```ts
behavior
  -> at(behavior)
  -> mapFunction(f, at(behavior))
```

The law says both paths produce the same meaning:

```ts
at(mapBehavior(f, behavior))
=
mapFunction(f, at(behavior))
```

Using the generic word `meaning`, the same law is:

```ts
meaning(operationOnAbstraction(x))
=
operationOnMeaning(meaning(x))
```

In pointwise form:

```ts
at(mapBehavior(f, behavior))(time)
=
f(at(behavior)(time))
```

So the operation on the abstraction must mean the corresponding operation on the model.

That is the homomorphism idea: the meaning function preserves structure. It translates the abstract operation into the corresponding model operation.

```ts
// Same shape, different levels:

mapBehavior(f, behavior)       // abstract level

mapFunction(f, at(behavior))   // meaning/model level

// Connected by the meaning function:

at(mapBehavior(f, behavior))
=
mapFunction(f, at(behavior))
```

This gives us a correctness rule. If `Behavior` claims to support `map`, its `map` should behave like `map` on its denotation, which is a function of time.

## The Main Lesson

Denotational design does not ask, "How do we build this?" first.

It asks:

> What are we talking about?

For FRP, the answer begins with:

```ts
Behavior<A> = Time -> A
```

That small equation gives the abstraction a center of gravity. Everything else can be designed around it.
