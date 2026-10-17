# The spec as it might look after the API grows: every response object schema
# gains a required and an optional field, every request object schema an
# optional one (a new required request field is a breaking change and should
# stop a release). The contract tests must still pass against it, so a test
# that pins a response's exact shape fails here instead of in the hourly
# release. Request schemas are found from the spec: those a requestBody
# references, and the ones they reference (oneOf members).
def refname: sub("^#/components/schemas/"; "");
def refs: [.. | objects | .["$ref"]? // empty | strings | refname];
def optional: .properties.xFutureOptional = {type: "integer", const: 7};
def required: .properties.xFutureRequired = {type: "string", const: "future"}
  | .required = ((.required // []) + ["xFutureRequired"]);
def grow($request):
  if type == "object" and .type == "object" and has("properties")
  then (if $request then optional else (required | optional) end)
  else . end;

([.paths[][] | objects | .requestBody? // empty | refs[]]) as $direct
| . as $spec
| ($direct + [$direct[] as $name | $spec.components.schemas[$name] | refs[]] | unique) as $requests
| .components.schemas |= with_entries(
    (.key as $k | $requests | index($k) != null) as $request
    | .value |= (grow($request) | if has("properties") then .properties |= map_values(grow($request)) else . end))
