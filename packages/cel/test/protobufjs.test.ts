import { describe, test } from 'bun:test';
import { TestEnvironment } from './helpers';
import type {
  RegisteredTypeFieldDeclaration,
  TypeConstructor,
} from '../src/index';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type AddressData = { street?: string; city?: string; zip?: string };

type PersonData = {
  name?: string;
  age?: number;
  email?: string;
  address?: object | null;
  tags?: string[];
  config?: Record<string, unknown>;
};

type CompanyData = { name?: string; employees?: object[] };

interface MessageType<Data> {
  fullName: string;
  create(data: Data): object;
  ctor: TypeConstructor;
  fields: Record<string, RegisteredTypeFieldDeclaration>;
}

interface ProtobufReflectionObject {
  add(object: unknown): this;
}

interface ProtobufNamespace extends ProtobufReflectionObject {
  resolveAll(): this;
  lookupType(path: string): MessageType<Record<string, unknown>>;
}

interface Protobuf {
  Root: new () => { define(path: string): ProtobufNamespace };
  Type: new (name: string) => ProtobufReflectionObject;
  Field: new (name: string, id: number, type: string, rule?: string) => object;
  MapField: new (
    name: string,
    id: number,
    keyType: string,
    type: string,
  ) => object;
}

function isProtobuf(value: unknown): value is Protobuf {
  return (
    value !== null &&
    typeof value === 'object' &&
    'Root' in value &&
    typeof value.Root === 'function' &&
    'Type' in value &&
    typeof value.Type === 'function' &&
    'Field' in value &&
    typeof value.Field === 'function' &&
    'MapField' in value &&
    typeof value.MapField === 'function'
  );
}

function loadProtobuf(): unknown {
  try {
    return require('protobufjs');
  } catch {
    return undefined;
  }
}

class CompanyMessage {
  name: string;
  employees: object[];

  constructor(data: CompanyData) {
    this.name = data.name ?? '';
    this.employees = data.employees ?? [];
  }
}

class PersonMessage {
  name: string;
  age: number;
  email: string;
  address: object | null;
  tags: string[];
  config: Record<string, unknown>;

  constructor(data: PersonData) {
    this.name = data.name ?? '';
    this.age = data.age ?? 0;
    this.email = data.email ?? '';
    this.address = data.address ?? null;
    this.tags = data.tags ?? [];
    this.config = data.config ?? {};
  }
}

class AddressMessage {
  street: string;
  city: string;
  zip: string;

  constructor(data: AddressData) {
    this.street = data.street ?? '';
    this.city = data.city ?? '';
    this.zip = data.zip ?? '';
  }
}

const protobuf = loadProtobuf();
let Person: MessageType<PersonData>;
let Address: MessageType<AddressData>;
let Company: MessageType<CompanyData>;

if (isProtobuf(protobuf)) {
  // Define proto schema inline
  const root = new protobuf.Root().define('test');

  // Define Address message
  root.add(
    new protobuf.Type('Address')
      .add(new protobuf.Field('street', 1, 'string'))
      .add(new protobuf.Field('city', 2, 'string'))
      .add(new protobuf.Field('zip', 3, 'string')),
  );

  // Define Person message with nested Address
  root.add(
    new protobuf.Type('Person')
      .add(new protobuf.Field('name', 1, 'string'))
      .add(new protobuf.Field('age', 2, 'int32'))
      .add(new protobuf.Field('email', 3, 'string'))
      .add(new protobuf.Field('address', 4, 'test.Address'))
      .add(new protobuf.Field('tags', 5, 'string', 'repeated'))
      .add(new protobuf.MapField('config', 6, 'string', 'string')),
  );

  // Define Company message
  root.add(
    new protobuf.Type('Company')
      .add(new protobuf.Field('name', 1, 'string'))
      .add(new protobuf.Field('employees', 2, 'test.Person', 'repeated')),
  );
  root.resolveAll();
  Address = root.lookupType('test.Address');
  Person = root.lookupType('test.Person');
  Company = root.lookupType('test.Company');
} else {
  // mock structure if protobufjs is not available
  Company = {
    fullName: '.test.Company',
    create: (data) => new CompanyMessage(data),
    ctor: CompanyMessage,
    fields: {
      name: { id: 1, type: 'string' },
      employees: { id: 2, type: 'test.Person', repeated: true },
    },
  };
  Person = {
    fullName: '.test.Person',
    create: (data) => new PersonMessage(data),
    ctor: PersonMessage,
    fields: {
      name: { id: 1, type: 'string' },
      age: { id: 2, type: 'double' },
      email: { id: 3, type: 'string' },
      address: { id: 4, type: 'test.Address' },
      tags: { id: 5, type: 'string', repeated: true },
      config: { id: 6, keyType: 'string', type: 'string', map: true },
    },
  };
  Address = {
    fullName: '.test.Address',
    create: (data) => new AddressMessage(data),
    ctor: AddressMessage,
    fields: {
      street: { id: 1, type: 'string' },
      city: { id: 2, type: 'string' },
      zip: { id: 3, type: 'string' },
    },
  };
}

describe('Protobufjs Message Support', () => {
  test('register protobufjs message type with CEL', () => {
    const env = new TestEnvironment();
    env.registerType(Address);
    env.registerType(Person);
    env.registerVariable('person', 'test.Person');

    const person = Person.create({
      name: 'Alice',
      age: 30,
      email: 'alice@example.com',
      address: Address.create({
        street: '123 Main St',
        city: 'Springfield',
        zip: '12345',
      }),
      tags: ['developer', 'manager'],
      config: { theme: 'dark', notifications: 'foo' },
    });

    env.expectEval('person.name', 'Alice', { person });
    env.expectEval('person.age', 30, { person });
    env.expectEval('person.email', 'alice@example.com', { person });
    env.expectEval('person.address.city', 'Springfield', { person });
    env.expectEvalDeep('person.tags', ['developer', 'manager'], { person });
    env.expectEvalDeep('person.config.theme', 'dark', { person });
    env.expectEvalDeep('person.config.notifications', 'foo', { person });
  });

  test('field access on nested protobufjs messages', () => {
    const env = new TestEnvironment();
    env.registerType(Address);
    env.registerType(Person);
    env.registerType(Company);
    env.registerVariable('company', 'test.Company');

    const company = Company.create({
      name: 'Acme Inc',
      employees: [
        Person.create({ name: 'Alice', age: 30, email: 'alice@acme.com' }),
        Person.create({ name: 'Bob', age: 25, email: 'bob@acme.com' }),
      ],
    });

    env.expectEval('company.name', 'Acme Inc', { company });
    env.expectEval('company.employees.size()', 2n, { company });
    env.expectEval('company.employees[0].name', 'Alice', { company });
    env.expectEval('company.employees[1].age', 25, { company });
  });

  test('type checking for protobufjs messages', () => {
    const env = new TestEnvironment();
    env.registerType(Address);
    env.registerType(Person);
    env.registerType(Company);
    env.registerVariable('person', 'test.Person');
    env.registerVariable('company', 'test.Company');

    env.expectType('person.name', 'string');
    env.expectType('person.age', 'double');
    env.expectType('company.employees[0].address', 'test.Address');
  });

  test('invalid field access on protobufjs messages', () => {
    const env = new TestEnvironment();
    env.registerType(Person);
    env.registerVariable('person', 'test.Person');

    const person = Person.create({ name: 'Alice', age: 30 });
    env.expectEvalThrows('person.nonexistent', /No such key: nonexistent/, {
      person,
    });
  });

  test('respects type checking, but trusts that messages are correctly structured', () => {
    const env = new TestEnvironment();
    env.registerType(Person);
    env.registerVariable('person', 'test.Person');
    env.registerVariable('dynPerson', 'dyn');

    const person = Person.create({
      name: 'Alice',
      age: 30,
      config: { theme: 1, mode: 'hello' },
    });
    const typemismatch = /Field 'theme' is not of type 'string', got 'double'/;
    env.expectEvalThrows('person.config.theme', typemismatch, {
      person: person,
    });

    // We trust that the protobuf message is correctly structured. Return values are passed as is.
    env.expectEval('dynPerson.config.theme', 1, { dynPerson: person });
    env.expectEval('dynPerson.config.mode', 'hello', { dynPerson: person });

    const err = /no such overload: string == int/;
    env.expectEvalThrows('person.config.theme == 1', err, { person: person });
    env.expectEval('dynPerson.config.theme == 1', true, { dynPerson: person });
    env.expectEval('dynPerson.config.theme == "hello"', false, {
      dynPerson: person,
    });
  });

  test('default values on protobufjs messages', () => {
    const env = new TestEnvironment();
    env.registerType(Person);
    env.registerVariable('person', 'test.Person');

    const person = Person.create({ name: 'Alice' });
    env.expectEval('person.age', 0, { person });
  });
});
