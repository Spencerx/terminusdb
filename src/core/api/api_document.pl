:- module(api_document, [
              api_get_document_read_transaction/5,
              api_get_document_write_transaction/8,
              api_generate_document_ids/6,
              api_generate_document_ids_by_type/6,
              api_generate_document_ids_by_query/7,
              api_get_document/6,
              api_insert_documents/6,
              api_delete_documents/4,
              api_delete_document/4,
              api_replace_documents/6,
              api_nuke_documents/3
          ]).

:- use_module(core(util)).
:- use_module(core(query)).
:- use_module(core(triple)).
:- use_module(core(transaction)).
:- use_module(core(document)).
:- use_module(core(account)).

:- use_module(library(http/json)).

document_auth_action_type(Descriptor_Type, Graph_Type_String, ReadWrite_String, Action) :-
    atom_string(Graph_Type, Graph_Type_String),
    atom_string(ReadWrite, ReadWrite_String),

    document_auth_action_type_(Descriptor_Type, Graph_Type, ReadWrite, Action).
document_auth_action_type_(system_descriptor, _, _, '@schema':'Action/manage_capabilities').
document_auth_action_type_(database_descriptor, _, read, '@schema':'Action/meta_read_access').
document_auth_action_type_(database_descriptor, instance, write, '@schema':'Action/meta_write_access').
document_auth_action_type_(repository_descriptor, _, read, '@schema':'Action/commit_read_access').
document_auth_action_type_(repository_descriptor, instance, write, '@schema':'Action/commit_write_access').
document_auth_action_type_(branch_descriptor, instance, read, '@schema':'Action/instance_read_access').
document_auth_action_type_(branch_descriptor, instance, write, '@schema':'Action/instance_write_access').
document_auth_action_type_(branch_descriptor, schema, read, '@schema':'Action/schema_read_access').
document_auth_action_type_(branch_descriptor, schema, write, '@schema':'Action/schema_write_access').
document_auth_action_type_(commit_descriptor, instance, read, '@schema':'Action/instance_read_access').
document_auth_action_type_(commit_descriptor, schema, read, '@schema':'Action/schema_read_access').

assert_document_auth(SystemDB, Auth, Descriptor, Graph_Type, ReadWrite) :-
    Descriptor_Type{} :< Descriptor,
    do_or_die(document_auth_action_type(Descriptor_Type, Graph_Type, ReadWrite, Action),
              error(document_access_impossible(Descriptor, Graph_Type, ReadWrite), _)),

    check_descriptor_auth(SystemDB, Descriptor, Action, Auth).

api_get_document_read_transaction(SystemDB, Auth, Path, Schema_Or_Instance, Transaction) :-
    do_or_die(
        resolve_absolute_string_descriptor(Path, Descriptor),
        error(invalid_path(Path),_)),

    assert_document_auth(SystemDB, Auth, Descriptor, Schema_Or_Instance, read),

    do_or_die(
        open_descriptor(Descriptor, Transaction),
        error(unresolvable_collection(Descriptor), _)).

api_get_document_write_transaction(SystemDB, Auth, Path, Schema_Or_Instance, Author, Message, Context, Transaction) :-
    do_or_die(
        resolve_absolute_string_descriptor(Path, Descriptor),
        error(invalid_path(Path),_)),

    assert_document_auth(SystemDB, Auth, Descriptor, Schema_Or_Instance, write),

    do_or_die(create_context(Descriptor, commit_info{author: Author, message: Message}, Context),
              error(unresolvable_collection(Descriptor), _)),
    do_or_die(query_default_collection(Context, Transaction),
              error(query_default_collection_failed_unexpectedly(Context), _)).

api_generate_document_ids(instance, Transaction, Unfold, Skip, Count, Id) :-
    (   Unfold = true
    ->  Include_Subdocuments = false
    ;   Include_Subdocuments = true),
    skip_generate_nsols(
        get_document_uri(Transaction, Include_Subdocuments, Id),
        Skip,
        Count).
api_generate_document_ids(schema, Transaction, _Unfold, Skip, Count, Id) :-
    skip_generate_nsols(
        get_schema_document_uri(Transaction, Id),
        Skip,
        Count).

api_generate_document_ids_by_type(instance, Transaction, Type, Skip, Count, Id) :-
    skip_generate_nsols(
        get_document_uri_by_type(Transaction, Type, Id),
        Skip,
        Count).
api_generate_document_ids_by_type(schema, Transaction, Type, Skip, Count, Id) :-
    skip_generate_nsols(
        get_schema_document_uri_by_type(Transaction, Type, Id),
        Skip,
        Count).

api_generate_document_ids_by_query(instance, Transaction, Type, Query, Skip, Count, Id) :-
    skip_generate_nsols(
        match_query_document_uri(Transaction, Type, Query, Id),
        Skip,
        Count).
api_generate_document_ids_by_query(schema, _Transaction, _Type, _Query, _Skip, _Count, _Id) :-
    throw(error(query_is_only_supported_for_instance_graphs, _)).

api_get_document(instance, Transaction, Compress_Ids, Unfold, Id, Document) :-
    do_or_die(get_document(Transaction, Compress_Ids, Unfold, Id, Document),
              error(document_not_found(Id), _)).

api_get_document(schema, Transaction, _Prefixed, _Unfold, Id, Document) :-
    do_or_die(get_schema_document(Transaction, Id, Document),
              error(document_not_found(Id), _)).

embed_document_in_error(Error, Document, New_Error) :-
    Error =.. Error_List,
    append(Error_List, [Document], New_Error_List),
    New_Error =.. New_Error_List.

known_document_error(type_not_found(_)).
known_document_error(can_not_insert_existing_object_with_id(_)).
known_document_error(unrecognized_property(_,_,_)).
known_document_error(casting_error(_,_)).
known_document_error(submitted_id_does_not_match_generated_id(_,_)).
known_document_error(submitted_document_id_does_not_have_expected_prefix(_,_)).
known_document_error(document_key_type_unknown(_)).
known_document_error(document_key_type_missing(_)).
known_document_error(subdocument_key_missing).
known_document_error(key_missing_required_field(_)).
known_document_error(document_key_not_object(_)).
known_document_error(empty_key).
known_document_error(bad_field_value(_, _)).
known_document_error(key_missing_fields(_)).
known_document_error(key_fields_not_an_array(_)).
known_document_error(key_fields_is_empty).
known_document_error(unable_to_assign_ids).

:- meta_predicate call_catch_document_mutation(+, :).
call_catch_document_mutation(Document, Goal) :-
    catch(Goal,
          error(E, Context),
          (   known_document_error(E)
          ->  embed_document_in_error(E, Document, New_E),
              throw(error(New_E, _))
          ;   throw(error(E, Context)))).

api_insert_document_(schema, Transaction, Stream, Id) :-
    json_read_dict_stream(Stream, JSON),
    (   is_list(JSON)
    ->  !,
        member(Document, JSON)
    ;   Document = JSON),
    call_catch_document_mutation(
        Document,
        do_or_die(insert_schema_document(Transaction, Document),
                  error(document_insertion_failed_unexpectedly(Document), _))),

    do_or_die(Id = (Document.get('@id')),
              error(document_has_no_id_somehow, _)).
api_insert_document_(instance, Transaction, Stream, Id) :-
    json_read_dict_stream(Stream, JSON),
    (   is_list(JSON)
    ->  !,
        member(Document, JSON)
    ;   Document = JSON),
    call_catch_document_mutation(
        Document,
        do_or_die(insert_document(Transaction, Document, Id),
                  error(document_insertion_failed_unexpectedly(Document), _))).

replace_existing_graph(schema, Transaction, Stream) :-
    replace_json_schema(Transaction, Stream).
replace_existing_graph(instance, Transaction, Stream) :-
    [RWO] = (Transaction.instance_objects),
    delete_all(RWO),
    forall(api_insert_document_(instance, Transaction, Stream, _),
           true).

api_insert_documents(Context, Transaction, Schema_Or_Instance, Full_Replace, Stream, Ids) :-
    stream_property(Stream, position(Pos)),
    with_transaction(Context,
                     (   set_stream_position(Stream, Pos),
                         Full_Replace = true
                     ->  replace_existing_graph(Schema_Or_Instance, Transaction, Stream),
                         Ids = []
                     ;   findall(Id,
                                 api_insert_document_(Schema_Or_Instance, Transaction, Stream, Id),
                                 Ids),
                         die_if(has_duplicates(Ids, Duplicates), error(same_ids_in_one_transaction(Duplicates), _))),
                     _).

api_delete_document_(schema, Transaction, Id) :-
    delete_schema_document(Transaction, Id).
api_delete_document_(instance, Transaction, Id) :-
    delete_document(Transaction, Id).

api_delete_documents(Context, Transaction, Schema_Or_Instance, Stream) :-
    stream_property(Stream, position(Pos)),
    with_transaction(Context,
                     (   set_stream_position(Stream, Pos),
                         forall(
                             (   json_read_dict_stream(Stream,JSON),
                                 (   is_list(JSON)
                                 ->  member(ID_Unchecked, JSON)
                                 ;   ID_Unchecked = JSON),
                                 param_check_json(string, id, ID_Unchecked, ID)),
                             api_delete_document_(Schema_Or_Instance, Transaction, ID))),
                     _).

api_delete_document(Context, Transaction, Schema_Or_Instance, ID) :-
    with_transaction(Context,
                     api_delete_document_(Schema_Or_Instance, Transaction, ID),
                     _).

api_nuke_documents_(schema, Transaction) :-
    nuke_schema_documents(Transaction).
api_nuke_documents_(instance, Transaction) :-
    nuke_documents(Transaction).

api_nuke_documents(Context, Transaction, Schema_Or_Instance) :-
    with_transaction(Context,
                     api_nuke_documents_(Schema_Or_Instance, Transaction),
                    _).

api_replace_document_(instance, Transaction, Document, Create, Id):-
    replace_document(Transaction, Document, Create, Id).
api_replace_document_(schema, Transaction, Document, Create, Id):-
    replace_schema_document(Transaction, Document, Create, Id).

api_replace_documents(Context, Transaction, Schema_Or_Instance, Stream, Create, Ids) :-
    stream_property(Stream, position(Pos)),
    with_transaction(Context,
                     (   set_stream_position(Stream, Pos),
                         findall(Id,
                                 (   json_read_dict_stream(Stream,JSON),
                                     (   is_list(JSON)
                                     ->  !,
                                         member(Document, JSON)
                                     ;   Document = JSON),
                                     call_catch_document_mutation(
                                         Document,
                                         api_replace_document_(Schema_Or_Instance,
                                                               Transaction,
                                                               Document,
                                                               Create,
                                                               Id))
                                 ),
                                 Ids),
                         die_if(has_duplicates(Ids, Duplicates), error(same_ids_in_one_transaction(Duplicates), _))
                     ),
                     _).

:- begin_tests(delete_document).
:- use_module(core(util/test_utils)).
:- use_module(core(transaction)).

insert_some_cities(System, Path) :-
    open_string('
{ "@type": "City",
  "@id" : "City/Dublin",
  "name" : "Dublin" }
{ "@type": "City",
  "@id" : "City/Pretoria",
  "name" : "Pretoria" }
{ "@type": "City",
  "@id" : "City/Utrecht",
  "name" : "Utrecht" }',
                Stream),
    api_get_document_write_transaction(System, 'User/admin', Path, instance, "author", "message", Context, Transaction),
    api_insert_documents(Context, Transaction, instance, false, Stream, _Out_Ids).

test(delete_objects_with_stream,
     [setup((setup_temp_store(State),
             create_db_with_test_schema(admin,foo))),
      cleanup(teardown_temp_store(State))
     ]) :-
    open_descriptor(system_descriptor{}, System),
    insert_some_cities(System, 'admin/foo'),

    open_string('"City/Dublin" "City/Pretoria"', Stream),
    api_get_document_write_transaction(System, 'User/admin', 'admin/foo', instance, "author", "message", Write_Context, Transaction),
    api_delete_documents(Write_Context, Transaction, instance, Stream),

    resolve_absolute_string_descriptor("admin/foo", Descriptor),
    create_context(Descriptor, Context),
    findall(Id_Compressed,
            (   get_document_uri(Context, true, Id),
                'document/json':compress_dict_uri(Id, Context.prefixes, Id_Compressed)),
            Ids),

    Ids = ['City/Utrecht'].

test(delete_objects_with_string,
     [setup((setup_temp_store(State),
             create_db_with_test_schema(admin,foo))),
      cleanup(teardown_temp_store(State))
     ]) :-
    open_descriptor(system_descriptor{}, System),
    insert_some_cities(System, 'admin/foo'),

    open_string('["City/Dublin", "City/Pretoria"]', Stream),
    api_get_document_write_transaction(System, 'User/admin', 'admin/foo', instance, "author", "message", Write_Context, Transaction),
    api_delete_documents(Write_Context, Transaction, instance, Stream),

    resolve_absolute_string_descriptor("admin/foo", Descriptor),
    create_context(Descriptor, Context),
    findall(Id_Compressed,
            (   get_document_uri(Context, true, Id),
                'document/json':compress_dict_uri(Id, Context.prefixes, Id_Compressed)),
            Ids),

    Ids = ['City/Utrecht'].

test(delete_objects_with_mixed_string_stream,
     [setup((setup_temp_store(State),
             create_db_with_test_schema(admin,foo))),
      cleanup(teardown_temp_store(State))
     ]) :-
    open_descriptor(system_descriptor{}, System),
    insert_some_cities(System, 'admin/foo'),

    open_string('"City/Dublin"\n["City/Pretoria"]', Stream),
    api_get_document_write_transaction(System, 'User/admin', 'admin/foo', instance, "author", "message", Write_Context, Transaction),
    api_delete_documents(Write_Context, Transaction, instance, Stream),

    resolve_absolute_string_descriptor("admin/foo", Descriptor),
    create_context(Descriptor, Context),
    findall(Id_Compressed,
            (   get_document_uri(Context, true, Id),
                'document/json':compress_dict_uri(Id, Context.prefixes, Id_Compressed)),
            Ids),

    Ids = ['City/Utrecht'].

:- end_tests(delete_document).

:- begin_tests(replace_document).
:- use_module(core(util/test_utils)).
:- use_module(core(transaction)).

insert_some_cities(System, Path) :-
    open_string('
{ "@type": "City",
  "@id" : "City/Dublin",
  "name" : "Dublin" }
{ "@type": "City",
  "@id" : "City/Pretoria",
  "name" : "Pretoria" }
{ "@type": "City",
  "@id" : "City/Utrecht",
  "name" : "Utrecht" }',
                Stream),
    api_get_document_write_transaction(System, 'User/admin', Path, instance, "author", "message", Context, Transaction),
    api_insert_documents(Context, Transaction, instance, false, Stream, _Out_Ids).

test(replace_objects_with_stream,
     [setup((setup_temp_store(State),
             create_db_with_test_schema(admin,foo))),
      cleanup(teardown_temp_store(State))
     ]) :-
    open_descriptor(system_descriptor{}, System),
    insert_some_cities(System, 'admin/foo'),

    open_string('
{ "@type": "City",
  "@id" : "City/Dublin",
  "name" : "Baile Atha Cliath" }
{ "@type": "City",
  "@id" : "City/Pretoria",
  "name" : "Tshwane" }', Stream),
    api_get_document_write_transaction(system_descriptor{}, 'User/admin', 'admin/foo', instance, "author", "message", Context, Transaction),
    api_replace_documents(Context, Transaction, instance, Stream, false, Ids),

    Ids = ['http://example.com/data/world/City/Dublin','http://example.com/data/world/City/Pretoria'].

:- end_tests(replace_document).


:- begin_tests(document_error_reporting).

:- use_module(core(util/test_utils)).
:- use_module(core(document)).
:- use_module(core(api/api_error)).

test(key_missing, [
         setup((setup_temp_store(State),
                create_db_with_empty_schema("admin", "testdb"),
                resolve_absolute_string_descriptor("admin/testdb", Desc))),
         cleanup(teardown_temp_store(State))
     ]) :-

    with_test_transaction(
        Desc,
        C1,
        insert_schema_document(
            C1,
            _{'@type': "Class",
              '@id': "Thing",
              '@key': _{'@type': "Lexical",
                        '@fields': ["field"]},
              field: "xsd:string"})
    ),

    Document = _{'@type': "Thing"},

    % GMG: this is clearly too elaborate to be an effective test...
    catch(
        call_catch_document_mutation(
            Document,
            with_test_transaction(
                Desc,
                C2,
                insert_document(
                    C2,
                    Document,
                    _)
            )
        ),
        Error,
        api_error_jsonld(
            insert_documents,
            Error,
            JSON
        )
    ),
    JSON = _{'@type':'api:InsertDocumentErrorResponse',
             'api:error':
             _{'@type':'api:RequiredKeyFieldMissing',
               'api:document':json{'@type':"Thing"},
               'api:field':'http://somewhere.for.now/schema#field'},
             'api:message':"The required field 'http://somewhere.for.now/schema#field' is missing from the submitted document",
             'api:status':"api:failure"
            }.

:- end_tests(document_error_reporting).
