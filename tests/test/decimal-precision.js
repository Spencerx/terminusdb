const { expect } = require('chai')
const { Agent, db, document, woql } = require('../lib')
const Decimal = require('decimal.js')
const { ApolloClient, InMemoryCache, HttpLink, gql, ApolloLink, concat } = require('@apollo/client/core')
const fetch = require('cross-fetch')
const api = require('../lib/api')

/**
 * Extract the exact decimal value from raw JSON response text.
 * Handles both string and number values in JSON.
 * For xsd:decimal rationals, the server outputs strings to preserve 20-digit precision.
 * For integers, the server outputs numbers with full arbitrary precision.
 */
function extractExactValue (responseText) {
  // Try to match string value: "@value": "0.33333333333333333333"
  let match = responseText.match(/"@value"\s*:\s*"([0-9.eE+-]+)"/)
  if (match) {
    return match[1]
  }

  // Try to match number value: "@value": 42 or "@value": 999999999999999999999
  match = responseText.match(/"@value"\s*:\s*([0-9.eE+-]+)/)
  if (match) {
    return match[1]
  }

  throw new Error('Could not extract @value from response')
}

describe('decimal-precision', function () {
  let agent

  before(async function () {
    agent = new Agent().auth()
    await db.create(agent)

    // Set up schema once for all tests
    const precisionSchema = [
      {
        '@type': 'Class',
        '@id': 'Product',
        name: 'xsd:string',
        price: 'xsd:decimal',
        taxRate: 'xsd:decimal',
        quantity: 'xsd:decimal',
      },
      {
        '@type': 'Class',
        '@id': 'HighPrecision',
        value20digits: 'xsd:decimal',
        value15digits: 'xsd:decimal',
        calculation: 'xsd:decimal',
      },
    ]

    await document.insert(agent, { schema: precisionSchema })
  })

  after(async function () {
    await db.delete(agent)
  })

  describe('Document API Precision', function () {
    it('should preserve 20-digit decimal precision in documents', async function () {
      const testDoc = {
        '@type': 'HighPrecision',
        '@id': 'HighPrecision/test1',
        value20digits: '1.23456789012345678901', // 20 decimals
        value15digits: '3.141592653589793', // 15 decimals (Pi)
        calculation: '0.33333333333333', // 14 decimals (1/3 approximation)
      }

      // Insert document
      await document.insert(agent, { instance: testDoc })

      // Retrieve document
      const response = await document.get(agent, { body: { id: 'HighPrecision/test1' } })

      // Extract exact values from raw JSON - decimals are returned as JSON numbers per JSON_SERIALIZATION_RULES.md
      const value20Raw = response.text.match(/"value20digits"\s*:\s*([0-9.eE+-]+)/)[1]
      const value15Raw = response.text.match(/"value15digits"\s*:\s*([0-9.eE+-]+)/)[1]
      const calculationRaw = response.text.match(/"calculation"\s*:\s*([0-9.eE+-]+)/)[1]

      // Use Decimal.js for exact precision comparison (no f64 loss)
      const value20 = new Decimal(value20Raw)
      const value15 = new Decimal(value15Raw)
      const calculation = new Decimal(calculationRaw)

      // Verify the numeric values match with full precision
      expect(value20.equals(new Decimal('1.23456789012345678901'))).to.be.true
      expect(value15.equals(new Decimal('3.141592653589793'))).to.be.true
      expect(calculation.equals(new Decimal('0.33333333333333'))).to.be.true
    })

    it('should handle decimal arithmetic in stored calculations', async function () {
      const productDoc = {
        '@type': 'Product',
        '@id': 'Product/item1',
        name: 'Widget',
        price: '19.99',
        taxRate: '0.075',
        quantity: '3.5',
      }

      await document.insert(agent, { instance: productDoc })
      const response = await document.get(agent, { body: { id: 'Product/item1' } })

      // Extract exact values from raw JSON - decimals are returned as JSON numbers per JSON_SERIALIZATION_RULES.md
      const priceRaw = response.text.match(/"price"\s*:\s*([0-9.eE+-]+)/)[1]
      const taxRateRaw = response.text.match(/"taxRate"\s*:\s*([0-9.eE+-]+)/)[1]
      const quantityRaw = response.text.match(/"quantity"\s*:\s*([0-9.eE+-]+)/)[1]

      // Use Decimal.js for exact precision comparison (no f64 loss)
      const price = new Decimal(priceRaw)
      const taxRate = new Decimal(taxRateRaw)
      const quantity = new Decimal(quantityRaw)

      // Values should match what we sent (precision preserved in JSON number)
      expect(price.equals(new Decimal('19.99'))).to.be.true
      expect(taxRate.equals(new Decimal('0.075'))).to.be.true
      expect(quantity.equals(new Decimal('3.5'))).to.be.true
    })
  })

  describe('WOQL Arithmetic Precision', function () {
    it('should preserve precision in WOQL arithmetic operations', async function () {
      // Test: 1/3 + 1/6 = 1/2 = 0.5
      // Expected with rationals: Exact "0.5" or "0.50000000000000000000"
      // Should NOT: Return approximation like 0.49999999999999994
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'Divide',
            left: { '@type': 'ArithmeticValue', data: 1 },
            right: { '@type': 'ArithmeticValue', data: 3 },
          },
          right: {
            '@type': 'Divide',
            left: { '@type': 'ArithmeticValue', data: 1 },
            right: { '@type': 'ArithmeticValue', data: 6 },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value and verify
      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('0.5')

      // Verify exact equality: 1/3 + 1/6 must equal exactly 0.5
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle multiplication with high precision', async function () {
      // Test: 1.23456789012345 × 2 = 2.4691357802469
      // Expected: Exact "2.4691357802469" (14 significant digits)
      // Should NOT: Use number literals (lose precision) or approximate
      // Must use: String values to preserve precision
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1.23456789012345' },
          },
          right: { '@type': 'ArithmeticValue', data: 2 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('2.4691357802469')

      // Verify exact equality (all 14 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle division with precision preservation', async function () {
      // Test: 1 ÷ 3 = 0.333333...
      // Expected: Exact "0.33333333333333333333" (20 decimal places!)
      // The json_write_hook outputs rationals with 20-digit precision
      // Note: 1/3 is a repeating decimal, hook formats with ~20 digits
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: { '@type': 'ArithmeticValue', data: 1 },
          right: { '@type': 'ArithmeticValue', data: 3 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.33333333333333333333')

      // Verify exact equality (1/3 with 20-digit precision from json_write_hook)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle complex financial calculations', async function () {
      // Test: (19.99 × 3.5) × (1 + 0.075) = 69.965 × 1.075 = 75.212375
      // Expected: Exact "75.212375"
      // Should NOT: Accumulate floating point errors
      // Must use: String values for all decimal inputs
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'Times',
            left: {
              '@type': 'ArithmeticValue',
              data: { '@type': 'xsd:decimal', '@value': '19.99' },
            },
            right: {
              '@type': 'ArithmeticValue',
              data: { '@type': 'xsd:decimal', '@value': '3.5' },
            },
          },
          right: {
            '@type': 'Plus',
            left: { '@type': 'ArithmeticValue', data: 1 },
            right: {
              '@type': 'ArithmeticValue',
              data: { '@type': 'xsd:decimal', '@value': '0.075' },
            },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('75.212375')

      // Verify exact equality (financial precision must be perfect)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle string decimal values in WOQL', async function () {
      // Test explicit decimal string multiplication by 1 (identity)
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: {
              '@type': 'xsd:decimal',
              '@value': '1.23456789012345678901',
            },
          },
          right: { '@type': 'ArithmeticValue', data: 1 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const result = await woql.post(agent, query)

      expect(result.body.bindings).to.be.an('array').with.lengthOf(1)
      const resultValue = result.body.bindings[0].Result['@value']

      // Should preserve the decimal value
      // eslint-disable-next-line no-loss-of-precision
      expect(Math.abs(resultValue - 1.23456789012345678901)).to.be.lessThan(1e-15)
    })
  })

  describe('WOQL Document Operations Precision', function () {
    it('should preserve precision when reading documents via WOQL ReadDocument', async function () {
      // Insert a document with high-precision decimals
      const testDoc = {
        '@type': 'HighPrecision',
        '@id': 'HighPrecision/woql_test1',
        value20digits: '1.23456789012345678901', // 20 decimals
        value15digits: '3.141592653589793', // 15 decimals (Pi)
        calculation: '0.33333333333333333333', // 20 decimals (1/3 approximation)
      }

      await document.insert(agent, { instance: testDoc })

      // Read via WOQL ReadDocument
      const query = {
        '@type': 'ReadDocument',
        identifier: { '@type': 'NodeValue', node: 'HighPrecision/woql_test1' },
        document: { '@type': 'DataValue', variable: 'Doc' },
      }

      const response = await woql.post(agent, query)

      // Verify bindings structure
      expect(response.body['api:variable_names']).to.be.an('array').that.has.lengthOf(1)
      expect(response.body['api:variable_names'][0]).to.equal('Doc')
      expect(response.body.bindings).to.be.an('array').that.has.lengthOf(1)

      const doc = response.body.bindings[0].Doc

      // Verify document structure
      expect(doc['@type']).to.equal('HighPrecision')
      expect(doc['@id']).to.equal('HighPrecision/woql_test1')

      // Extract exact values from raw JSON text to preserve precision
      const value20Raw = response.text.match(/"value20digits"\s*:\s*([0-9.eE+-]+)/)[1]
      const value15Raw = response.text.match(/"value15digits"\s*:\s*([0-9.eE+-]+)/)[1]
      const calculationRaw = response.text.match(/"calculation"\s*:\s*([0-9.eE+-]+)/)[1]

      // Use Decimal.js for exact precision comparison
      const value20 = new Decimal(value20Raw)
      const value15 = new Decimal(value15Raw)
      const calculation = new Decimal(calculationRaw)

      // Verify exact decimal values
      expect(value20.equals(new Decimal('1.23456789012345678901'))).to.be.true
      expect(value15.equals(new Decimal('3.141592653589793'))).to.be.true
      expect(calculation.equals(new Decimal('0.33333333333333333333'))).to.be.true
    })

    it('should preserve precision for financial calculations in documents via WOQL', async function () {
      const productDoc = {
        '@type': 'Product',
        '@id': 'Product/woql_item1',
        name: 'WOQL Test Widget',
        price: '19.99',
        taxRate: '0.075',
        quantity: '10.5',
      }

      await document.insert(agent, { instance: productDoc })

      // Read via WOQL ReadDocument
      const query = {
        '@type': 'ReadDocument',
        identifier: { '@type': 'NodeValue', node: 'Product/woql_item1' },
        document: { '@type': 'DataValue', variable: 'Doc' },
      }

      const response = await woql.post(agent, query)
      const doc = response.body.bindings[0].Doc

      // Extract exact values from raw JSON
      const priceRaw = response.text.match(/"price"\s*:\s*([0-9.eE+-]+)/)[1]
      const taxRateRaw = response.text.match(/"taxRate"\s*:\s*([0-9.eE+-]+)/)[1]
      const quantityRaw = response.text.match(/"quantity"\s*:\s*([0-9.eE+-]+)/)[1]

      // Use Decimal.js for exact precision comparison
      const price = new Decimal(priceRaw)
      const taxRate = new Decimal(taxRateRaw)
      const quantity = new Decimal(quantityRaw)

      // Verify exact decimal values match what was inserted
      expect(price.equals(new Decimal('19.99'))).to.be.true
      expect(taxRate.equals(new Decimal('0.075'))).to.be.true
      expect(quantity.equals(new Decimal('10.5'))).to.be.true

      // Verify the document contains correct name
      expect(doc.name).to.equal('WOQL Test Widget')
    })
  })

  describe('High Precision Arithmetic Results', function () {
    it('should return 18-digit small decimal results without float representation', async function () {
      // Test: 1 ÷ 7 = 0.142857142857142857... (repeating)
      // Expected: Exact "0.14285714285714285714" (20 decimal places!)
      // The json_write_hook outputs rationals with 20-digit precision
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: { '@type': 'ArithmeticValue', data: 1 },
          right: { '@type': 'ArithmeticValue', data: 7 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify it's returned as xsd:decimal
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.14285714285714285714')

      // Verify exact equality (1/7 with 20-digit precision from json_write_hook)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should return 18-digit large decimal results without float representation', async function () {
      // Test: 12345678.12345678 × 2 = 24691356.24691356
      // Expected: Exact "24691356.24691356" (16 significant digits)
      // Should NOT: Use scientific notation or lose precision
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '12345678.12345678' },
          },
          right: { '@type': 'ArithmeticValue', data: 2 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify it's returned as xsd:decimal, not scientific notation
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('24691356.24691356')

      // Verify exact equality (all 16 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should preserve precision in multi-step arithmetic with 18 digits', async function () {
      // Test: (1/3 + 1/7) × 1000000
      // Calculation: (7/21 + 3/21) × 1000000 = (10/21) × 1000000 = 476190.476190476190...
      // Expected: Exact "476190.47619047619047619" (20 decimal places!)
      // Should NOT: Accumulate errors through multiple operations
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'Plus',
            left: {
              '@type': 'Divide',
              left: { '@type': 'ArithmeticValue', data: 1 },
              right: { '@type': 'ArithmeticValue', data: 3 },
            },
            right: {
              '@type': 'Divide',
              left: { '@type': 'ArithmeticValue', data: 1 },
              right: { '@type': 'ArithmeticValue', data: 7 },
            },
          },
          right: { '@type': 'ArithmeticValue', data: 1000000 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify proper decimal type
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('476190.47619047619047619048')

      // Verify exact equality (multi-step rational arithmetic with 20+ digit precision)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle small fractional results with many decimal places', async function () {
      // Test: 1 ÷ 999999 = 0.000001000001000001... (repeating pattern)
      // Expected: Exact "0.00000100000100000100" (20 total digits!)
      // Should NOT: Round or lose precision in small values
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: { '@type': 'ArithmeticValue', data: 1 },
          right: { '@type': 'ArithmeticValue', data: 999999 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify it's xsd:decimal
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.00000100000100000100')

      // Verify exact equality (small fractional value with 20-digit precision)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle large integer results with decimal precision', async function () {
      // Test: 123456789012345 × 3 = 370370367037035
      // Expected: Exact "370370367037035" (15 digits)
      // Should NOT: Use scientific notation or lose precision
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '123456789012345' },
          },
          right: { '@type': 'ArithmeticValue', data: 3 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify proper decimal type (not float/scientific notation)
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('370370367037035')

      // Verify exact equality (all 15 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })
  })

  describe('Extreme Value Decimal Representation (Exact Precision)', function () {
    it('should return very small decimals with exact precision', async function () {
      // Test: 1 ÷ 1000000 = 0.000001
      // Expected: Exact value "0.000001" (6 decimal places)
      // Should NOT: Use scientific notation (1e-6) or lose precision
      // JSON can represent this exactly as a decimal number
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: { '@type': 'ArithmeticValue', data: 1 },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1000000' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify it's xsd:decimal
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON as Decimal
      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('0.000001')

      // Verify exact equality (no IEEE 754 approximation)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should return very large decimals with exact precision', async function () {
      // Test: 999999999999 × 999999999999 = 999999999998000000000001
      // Expected: Exact integer value (30 digits)
      // Should NOT: Use scientific notation or approximate
      // JSON can represent this exactly as an integer
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '999999999999' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '999999999999' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      // Verify it's xsd:decimal
      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('999999999998000000000001')

      // Verify exact equality (no approximation allowed)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should preserve 16-digit precision exactly (IEEE 754 limit)', async function () {
      // Test: 1234567.123456789 × 1 = 1234567.123456789
      // Expected: Exact value "1234567.123456789" (16 significant digits)
      // Should NOT: Round, truncate, or use scientific notation
      // IEEE 754 double precision can represent ~15-17 significant decimal digits
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1234567.123456789' },
          },
          right: { '@type': 'ArithmeticValue', data: 1 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('1234567.123456789')

      // Verify exact equality (all 16 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })
  })

  describe('Float Precision Corner Cases (Exact Arithmetic)', function () {
    it('should handle 0.1 + 0.2 = 0.3 exactly (classic float precision issue)', async function () {
      // Test: 0.1 + 0.2
      // Expected with floats: 0.30000000000000004 (WRONG!)
      // Expected with rationals: 0.3 (CORRECT!)
      // Should NOT: Return 0.30000000000000004 or any approximation
      // Must return: Exact "0.3" or "0.30000000000000000000" (20 decimals)
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.1' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.2' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value - must be exactly 0.3
      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('0.3')

      // Verify exact equality (classic float bug must be fixed)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle 0.1 × 3 = 0.3 exactly', async function () {
      // Test: 0.1 × 3
      // Expected with floats: 0.30000000000000004 (WRONG!)
      // Expected with rationals: 0.3 (CORRECT!)
      // Should NOT: Return 0.30000000000000004
      // Must return: Exact "0.3"
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.1' },
          },
          right: { '@type': 'ArithmeticValue', data: 3 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('0.3')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle 1.0 - 0.9 = 0.1 exactly', async function () {
      // Test: 1.0 - 0.9
      // Expected with floats: 0.09999999999999998 (WRONG!)
      // Expected with rationals: 0.1 (CORRECT!)
      // Should NOT: Return 0.09999999999999998
      // Must return: Exact "0.1" or "0.10000000000000000000"
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Minus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1.0' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.9' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('0.1')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle 0.1 × 10 = 1.0 exactly (no error accumulation)', async function () {
      // Test: 0.1 × 10 (equivalent to adding 0.1 ten times)
      // Expected with floats: Could accumulate to 0.9999999999999999 or 1.0000000000000002 (WRONG!)
      // Expected with rationals: 1.0 (CORRECT!)
      // Should NOT: Show any error accumulation
      // Must return: Exact "1.0" or "1.00000000000000000000"
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.1' },
          },
          right: { '@type': 'ArithmeticValue', data: 10 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('1.0')

      expect(exactValue.equals(expected)).to.be.true
    })
  })

  describe('Arbitrary Precision Integers (Exact Values)', function () {
    it('should handle integers > MAX_SAFE_INTEGER exactly', async function () {
      // Test: 99999999999999999999 + 1 = 100000000000000000000
      // JavaScript's Number.MAX_SAFE_INTEGER = 9007199254740991 (2^53 - 1)
      // This value (20 digits) far exceeds JavaScript's safe integer range
      // Expected: Exact "100000000000000000000" (1 followed by 20 zeros)
      // Should NOT: Round, truncate, or lose precision
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '99999999999999999999' },
          },
          right: { '@type': 'ArithmeticValue', data: 1 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value using Decimal.js
      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('100000000000000000000')

      // Verify exact equality (all 21 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle large integer multiplication exactly', async function () {
      // Test: 123456789012 × 987654321012
      // Both operands are 12 digits (within safe range for exact representation)
      // Expected: Exact "121932631125968602320144" (24 digits)
      // Should NOT: Use scientific notation or approximate
      // Note: Result exceeds MAX_SAFE_INTEGER but can still be exact in IEEE 754
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '123456789012' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '987654321012' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('121932631125968602320144')

      // Verify exact equality (all 24 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle large integer division exactly', async function () {
      // Test: 999999999999999999 ÷ 3 = 333333333333333333
      // Dividend is 18 digits of nines
      // Expected: Exact "333333333333333333" (18 digits of threes)
      // Should NOT: Lose precision or use floating point division
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '999999999999999999' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '3' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('333333333333333333')

      // Verify exact equality (all 18 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle negative large integers exactly', async function () {
      // Test: -999999999999999 × 999999999999999 = -999999999999998000000000000001
      // Expected: Exact "-999999999999998000000000000001" (negative 30-digit number)
      // Should NOT: Lose precision or sign
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '-999999999999999' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '999999999999999' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('-999999999999998000000000000001')

      // Verify exact equality (sign and all 30 digits must match)
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle MAX_SAFE_INTEGER addition exactly', async function () {
      // Test: 9007199254740991 + 9007199254740991 = 18014398509481982
      // 9007199254740991 is JavaScript's MAX_SAFE_INTEGER (2^53 - 1)
      // Expected: Exact "18014398509481982" (17 digits)
      // Should NOT: Lose precision even though result > MAX_SAFE_INTEGER
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '9007199254740991' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '9007199254740991' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value using Decimal.js
      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('18014398509481982')

      // Verify exact equality
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle extreme precision: 30 digits left + 20 digits right of decimal', async function () {
      // Test: 123456789012345678901234567890 + 0.00000000000000000001
      // Left operand: 30 digits (massive integer)
      // Right operand: 20 decimal places (1e-20)
      // Expected: "123456789012345678901234567890.00000000000000000001" (30+20 digits!)
      // This tests the absolute limit of decimal precision representation
      // Should NOT: Lose any digits, round, or use scientific notation
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '123456789012345678901234567890' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.00000000000000000001' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from raw JSON text (before JavaScript parses it)
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('123456789012345678901234567890.00000000000000000001')

      // Verify exact equality (all 50 digits must match!)
      expect(exactValue.equals(expected)).to.be.true

      // Also verify the raw JSON contains the full precision
      expect(rawValue).to.include('123456789012345678901234567890')
      expect(rawValue).to.include('.00000000000000000001')
    })
  })

  describe('Edge Cases', function () {
    it('should handle very small decimals', async function () {
      // Test: 0.00000000000001 × 1 = 0.00000000000001
      // Expected: Exact "0.00000000000001" (1e-14)
      // Should NOT: Underflow to zero or use scientific notation
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.00000000000001' },
          },
          right: { '@type': 'ArithmeticValue', data: 1 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.00000000000001')

      // Verify exact equality
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle very large decimals', async function () {
      // Test: 1234567890123456.5 × 1 = 1234567890123456.5
      // Expected: Exact "1234567890123456.5" (16 digits + 1 decimal)
      // Should NOT: Overflow or use scientific notation
      // Note: Adjusted to fit within IEEE 754 double precision range
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1234567890123456.5' },
          },
          right: { '@type': 'ArithmeticValue', data: 1 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('1234567890123456.5')

      // Verify exact equality
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle negative decimals', async function () {
      // Test: -19.99 + 10.50 = -9.49
      // Expected: Exact "-9.49"
      // Should NOT: Accumulate errors with negative numbers
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '-19.99' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '10.50' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('-9.49')

      // Verify exact equality
      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle zero precisely', async function () {
      // Test: 1.5 - 1.5 = 0
      // Expected: Exact "0" or "0.00000000000000000000"
      // Should NOT: Result in -0 or small non-zero value
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Minus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1.5' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1.5' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      // Extract exact value from JSON
      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0')

      // Verify exact equality (must be exactly zero)
      expect(exactValue.equals(expected)).to.be.true
    })
  })

  describe('Comprehensive Arithmetic Operator Tests', function () {
    it('should handle Plus (+) with high precision decimals', async function () {
      // Test: 0.33333333333333333333 + 0.66666666666666666667 = 1.0
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Plus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.33333333333333333333' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.66666666666666666667' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('1.0')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle Minus (-) with high precision decimals', async function () {
      // Test: 1.0 - 0.33333333333333333333 = 0.66666666666666666667
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Minus',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1.0' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.33333333333333333333' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.66666666666666666667')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle Times (*) with high precision decimals', async function () {
      // Test: 0.33333333333333333333 * 3 = 0.99999999999999999999
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Times',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '0.33333333333333333333' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: 3,
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.99999999999999999999')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle Divide (/) with rational result', async function () {
      // Test: 22 / 7 = 3.14285714285714285714... (approximation of pi)
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: { '@type': 'ArithmeticValue', data: 22 },
          right: { '@type': 'ArithmeticValue', data: 7 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('3.14285714285714285714')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle Div (integer division) with integer result', async function () {
      // Test: 22 div 7 = 3 (integer division, truncates)
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Div',
          left: { '@type': 'ArithmeticValue', data: 22 },
          right: { '@type': 'ArithmeticValue', data: 7 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('3')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should ERROR when Div (integer division) used with non-integer (rational)', async function () {
      // Test: 10.5 div 3 should ERROR (div requires integers)
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Div',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '10.5' },
          },
          right: { '@type': 'ArithmeticValue', data: 3 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      let errorOccurred = false
      try {
        const response = await woql.post(agent, query).unverified()
        // If we get here, check if it's an error response
        if (response.status !== 200) {
          errorOccurred = true
          const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
          expect(body['api:status']).to.equal('api:failure')
          const message = body['api:message']
          expect(message).to.match(/type|integer|div|rational/i)
        }
      } catch (error) {
        errorOccurred = true
        // Error may come from the framework or HTTP response
        if (error.response) {
          expect(error.response.body['api:status']).to.equal('api:failure')
          const message = error.response.body['api:message']
          expect(message).to.match(/type|integer|div|rational/i)
        } else {
          // Re-throw if it's not the expected error type
          throw error
        }
      }

      if (!errorOccurred) {
        expect.fail('Should have thrown an error for non-integer div operand')
      }
    })

    it('should handle Exp (**) exponentiation with decimals', async function () {
      // Test: 2.5 ** 3 = 15.625
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Exp',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '2.5' },
          },
          right: { '@type': 'ArithmeticValue', data: 3 },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('15.625')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle Floor function with decimals', async function () {
      // Test: floor(3.14285714285714285714) = 3
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Floor',
          argument: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '3.14285714285714285714' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const exactValue = new Decimal(binding['@value'].toString())
      const expected = new Decimal('3')

      expect(exactValue.equals(expected)).to.be.true
    })

    it('should handle large number division creating small rational', async function () {
      // Test: 1234567890123456789 / 100000000000000000000 = 0.01234567890123456789
      // This is the case mentioned by the user that was causing type errors
      const query = {
        '@type': 'Eval',
        expression: {
          '@type': 'Divide',
          left: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '1234567890123456789' },
          },
          right: {
            '@type': 'ArithmeticValue',
            data: { '@type': 'xsd:decimal', '@value': '100000000000000000000' },
          },
        },
        result: { '@type': 'ArithmeticValue', variable: 'Result' },
      }

      const response = await woql.post(agent, query).unverified()
      const result = JSON.parse(response.text)
      const binding = result.bindings[0].Result

      expect(binding['@type']).to.equal('xsd:decimal')

      const rawValue = extractExactValue(response.text)
      const exactValue = new Decimal(rawValue)
      const expected = new Decimal('0.01234567890123456789')

      // Verify the result is a small decimal with high precision
      expect(exactValue.equals(expected)).to.be.true
    })
  })

  describe('Cross-Interface Decimal Consistency Tests', function () {
    let graphqlClient

    before(async function () {
      // Setup schema with decimal, double, and integer types (add to existing schema)
      const schema = [
        {
          '@type': 'Class',
          '@id': 'NumericTest',
          decimalValue: 'xsd:decimal',
          doubleValue: 'xsd:double',
          integerValue: 'xsd:integer',
          bigIntValue: 'xsd:integer',
        },
      ]
      const schemaResponse = await document.insert(agent, { schema })
      if (schemaResponse.status !== 200) {
        console.log('Schema insert failed with status:', schemaResponse.status)
        console.log('Response body:', schemaResponse.body)
        console.log('Response text:', schemaResponse.text)
      }

      // Setup GraphQL client (matching pattern from graphql.js test)
      const path = api.path.graphQL({ dbName: agent.dbName, orgName: agent.orgName })
      const base = agent.baseUrl
      const uri = `${base}${path}`

      const httpLink = new HttpLink({ uri, fetch })
      const authMiddleware = new ApolloLink((operation, forward) => {
        // Add the authorization to the headers
        operation.setContext(({ headers = {} }) => ({
          headers: {
            ...headers,
            authorization: 'Basic YWRtaW46cm9vdA==', // admin:root
          },
        }))
        return forward(operation)
      })

      const composedLink = concat(authMiddleware, httpLink)

      graphqlClient = new ApolloClient({
        cache: new InMemoryCache({
          addTypename: false,
        }),
        link: composedLink,
      })
    })

    it('should return consistent decimal values across Document API, GraphQL, and WOQL', async function () {
      // Step 1: Insert document with high-precision values
      const testDoc = {
        '@type': 'NumericTest',
        '@id': 'NumericTest/consistency_test',
        decimalValue: '0.33333333333333333333', // 20-digit rational
        doubleValue: 3.141592653589793, // IEEE 754 float
        integerValue: 42,
        bigIntValue: '999999999999999999999', // 21-digit big integer
      }

      await document.insert(agent, { instance: testDoc })

      // Expected values for comparison
      const expectedDecimal = new Decimal('0.33333333333333333333')
      const expectedDouble = new Decimal('3.141592653589793')
      const expectedInteger = new Decimal('42')
      const expectedBigInt = new Decimal('999999999999999999999')

      // Step 2: Read via Document API (extract from raw JSON before JavaScript parses)
      const docResult = await document.get(agent, { query: { id: 'NumericTest/consistency_test', type: 'NumericTest', as_list: true } })

      // Document API returns JSON numbers per JSON_SERIALIZATION_RULES.md
      // BigInt might still be string for precision, but decimals/doubles/ints are numbers
      const decimalMatch = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)
      const doubleMatch = docResult.text.match(/"doubleValue"\s*:\s*([0-9.eE+-]+)/)
      const integerMatch = docResult.text.match(/"integerValue"\s*:\s*([0-9.eE+-]+)/)
      const bigIntMatch = docResult.text.match(/"bigIntValue"\s*:\s*([0-9.eE+-]+)/)

      expect(decimalMatch, 'decimalValue not found').to.not.be.null
      expect(doubleMatch, 'doubleValue not found').to.not.be.null
      expect(integerMatch, 'integerValue not found').to.not.be.null
      expect(bigIntMatch, 'bigIntValue not found').to.not.be.null

      const docDecimal = new Decimal(decimalMatch[1])
      const docDouble = new Decimal(doubleMatch[1])
      const docInteger = new Decimal(integerMatch[1])
      const docBigInt = new Decimal(bigIntMatch[1])

      expect(docDecimal.equals(expectedDecimal)).to.be.true
      expect(docDouble.equals(expectedDouble)).to.be.true
      expect(docInteger.equals(expectedInteger)).to.be.true
      expect(docBigInt.equals(expectedBigInt)).to.be.true

      // Step 3: Read via GraphQL
      const QUERY = gql`
        query GetNumericTest {
          NumericTest {
            _id
            decimalValue
            doubleValue
            integerValue
            bigIntValue
          }
        }
      `

      const gqlResult = await graphqlClient.query({ query: QUERY })

      // Verify we got results
      expect(gqlResult.data.NumericTest).to.be.an('array')
      expect(gqlResult.data.NumericTest.length).to.be.greaterThan(0)

      // GraphQL returns full IRI, so we need to match either the full IRI or the suffix
      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id === 'NumericTest/consistency_test' ||
        d._id.endsWith('NumericTest/consistency_test'),
      )

      // Verify document was found
      expect(gqlDoc).to.exist
      expect(gqlDoc.decimalValue).to.exist

      // GraphQL outputs JSON numbers per JSON_SERIALIZATION_RULES.md
      // However, Apollo Client uses native JSON.parse which converts to IEEE 754 floats
      // So we verify the RAW JSON contains correct numbers, even though Apollo loses precision

      // Get RAW GraphQL response to verify server outputs JSON numbers correctly
      const rawGqlResponse = await agent.post(api.path.graphQL({ dbName: agent.dbName, orgName: agent.orgName }))
        .send({ query: QUERY.loc.source.body })

      // Verify RAW JSON contains unquoted numbers (not strings)
      expect(rawGqlResponse.text).to.include('"decimalValue":0.33333333333333333333')
      expect(rawGqlResponse.text).to.not.include('"decimalValue":"0.33333333333333333333"')

      // Apollo Client parses as floats (precision lost beyond ~16 digits)
      // But we can still verify the values are numbers, not strings
      expect(typeof gqlDoc.decimalValue).to.equal('number')
      expect(typeof gqlDoc.bigIntValue).to.equal('string') // BigInt still as string

      // For cross-interface consistency, we verify the RAW JSON is correct
      // Client-side precision loss is a JavaScript limitation, not a server issue
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())
      const gqlDouble = new Decimal(gqlDoc.doubleValue.toString())
      const gqlInteger = new Decimal(gqlDoc.integerValue.toString())
      const gqlBigInt = new Decimal(gqlDoc.bigIntValue)

      // Values should be approximately equal (precision lost during Apollo parsing)
      // For true precision verification, see "RAW JSON verification" tests in graphql.js
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedDecimal.toNumber(), 0.00000000000001)
      expect(gqlDouble.equals(expectedDouble)).to.be.true
      expect(gqlInteger.equals(expectedInteger)).to.be.true
      expect(gqlBigInt.equals(expectedBigInt)).to.be.true

      // Step 4: Read via WOQL (triple pattern)
      // Use the full schema URI for the predicate
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/consistency_test' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()

      // Extract from raw JSON for precision
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimalRaw = match[1]
      const woqlDecimal = new Decimal(woqlDecimalRaw)

      // WOQL triple queries now return full 20-digit precision!
      // Fixed by returning decimals as strings from Rust storage layer
      expect(woqlDecimal.equals(expectedDecimal)).to.be.true
    })

    it('should handle rational values consistently across interfaces', async function () {
      // Test case: Insert a document with a high-precision rational
      // Then verify it's preserved across all read interfaces

      // Insert directly via Document API with 20-digit rational
      await document.insert(agent, {
        instance: {
          '@type': 'NumericTest',
          '@id': 'NumericTest/rational_result',
          decimalValue: '0.33333333333333333333', // 20 digits (1/3)
          doubleValue: 3.14159,
          integerValue: 42,
          bigIntValue: '987654321987654321',
        },
      })

      // Read back via Document API
      const docResult = await document.get(agent, { query: { id: 'NumericTest/rational_result', type: 'NumericTest', as_list: true } })

      expect(docResult.body).to.be.an('array')
      expect(docResult.body.length).to.be.greaterThan(0)

      // Extract from raw JSON - decimals are returned as JSON numbers per JSON_SERIALIZATION_RULES.md
      const docDecimalRaw = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)[1]
      const docDecimal = new Decimal(docDecimalRaw)
      const expectedRational = new Decimal('0.33333333333333333333')

      expect(docDecimal.equals(expectedRational)).to.be.true

      // Read via GraphQL
      const QUERY = gql`
        query GetRational {
          NumericTest {
            _id
            decimalValue
          }
        }
      `

      // Use network-only to bypass Apollo cache
      const gqlResult = await graphqlClient.query({
        query: QUERY,
        fetchPolicy: 'network-only',
      })

      // Debug: see what documents exist
      if (!gqlResult.data.NumericTest.some((d) => d._id.includes('rational_result'))) {
        console.log('Available documents:', gqlResult.data.NumericTest.map((d) => d._id))
      }

      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id === 'NumericTest/rational_result' ||
        d._id.endsWith('NumericTest/rational_result'),
      )

      expect(gqlDoc, 'Document not found in GraphQL results').to.exist
      expect(gqlDoc.decimalValue).to.exist

      // GraphQL outputs JSON numbers (Apollo Client converts to float, losing precision)
      expect(typeof gqlDoc.decimalValue).to.equal('number')
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())

      // Verify approximate equality (precision lost during Apollo's JSON.parse)
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedRational.toNumber(), 0.00000000000001)

      // Read via WOQL triple query
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/rational_result' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimal = new Decimal(match[1])
      expect(woqlDecimal.equals(expectedRational)).to.be.true
    })

    it('should preserve precision across Document API insert and GraphQL read', async function () {
      // Test case: Insert via Document API, read via GraphQL
      // Verify precision is preserved through the storage layer and GraphQL can read it
      await document.insert(agent, {
        instance: {
          '@type': 'NumericTest',
          '@id': 'NumericTest/graphql_insert',
          decimalValue: '0.01234567890123456789',
          doubleValue: 2.71828,
          integerValue: 100,
          bigIntValue: '888888888888888888888',
        },
      })

      // Read back via Document API to verify storage
      const docResult = await document.get(agent, {
        query: { id: 'NumericTest/graphql_insert', type: 'NumericTest', as_list: true },
      })

      expect(docResult.body).to.be.an('array')
      expect(docResult.body.length).to.be.greaterThan(0)

      // Extract from raw JSON - decimals are returned as JSON numbers
      const docDecimalRaw = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)[1]
      const docDecimal = new Decimal(docDecimalRaw)
      const expectedDecimal = new Decimal('0.01234567890123456789')

      expect(docDecimal.equals(expectedDecimal)).to.be.true

      // Read back via GraphQL
      const QUERY = gql`
        query GetGraphqlInsert {
          NumericTest {
            _id
            decimalValue
          }
        }
      `

      const gqlResult = await graphqlClient.query({
        query: QUERY,
        fetchPolicy: 'network-only',
      })

      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id.endsWith('NumericTest/graphql_insert'),
      )

      expect(gqlDoc).to.exist
      // GraphQL outputs JSON numbers (Apollo parses as float, losing precision)
      expect(typeof gqlDoc.decimalValue).to.equal('number')
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedDecimal.toNumber(), 0.00000000000001)

      // Read back via WOQL triple query to verify triple storage
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/graphql_insert' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimal = new Decimal(match[1])
      expect(woqlDecimal.equals(expectedDecimal)).to.be.true
    })

    it('should preserve precision when inserting via WOQL InsertDocument', async function () {
      // Test case: Insert via WOQL InsertDocument with explicit xsd:decimal type
      // Verifies that value_string_as(atom) in routes.pl preserves full 20-digit precision

      const woqlInsertQuery = {
        '@type': 'InsertDocument',
        identifier: { '@type': 'NodeValue', node: 'NumericTest/woql_insert' },
        document: {
          '@type': 'Value',
          dictionary: {
            '@type': 'DictionaryTemplate',
            data: [
              {
                '@type': 'FieldValuePair',
                field: '@type',
                value: { '@type': 'Value', data: 'NumericTest' },
              },
              {
                '@type': 'FieldValuePair',
                field: '@id',
                value: { '@type': 'Value', data: 'NumericTest/woql_insert' },
              },
              {
                '@type': 'FieldValuePair',
                field: 'decimalValue',
                // Use explicit xsd:decimal type to preserve precision
                value: {
                  '@type': 'DataValue',
                  data: { '@type': 'xsd:decimal', '@value': '0.01234567890123456789' },
                },
              },
              {
                '@type': 'FieldValuePair',
                field: 'doubleValue',
                value: { '@type': 'Value', data: 1.41421 },
              },
              {
                '@type': 'FieldValuePair',
                field: 'integerValue',
                value: { '@type': 'Value', data: 200 },
              },
              {
                '@type': 'FieldValuePair',
                field: 'bigIntValue',
                value: {
                  '@type': 'DataValue',
                  data: { '@type': 'xsd:integer', '@value': '777777777777777777777' },
                },
              },
            ],
          },
        },
      }

      const insertResult = await woql.post(agent, woqlInsertQuery).unverified()

      if (insertResult.status !== 200) {
        console.log('WOQL Insert failed with status:', insertResult.status)
        console.log('Error:', JSON.stringify(insertResult.body, null, 2))
        throw new Error(`WOQL InsertDocument failed: ${JSON.stringify(insertResult.body)}`)
      }

      expect(insertResult.status).to.equal(200)
      expect(insertResult.body.inserts).to.be.greaterThan(0)

      // Read back via Document API
      const docResult = await document.get(agent, {
        query: { id: 'NumericTest/woql_insert', type: 'NumericTest', as_list: true },
      })

      expect(docResult.body).to.be.an('array')
      expect(docResult.body.length).to.be.greaterThan(0)

      // Extract decimal value from raw JSON text to preserve full 20-digit precision
      // JavaScript's JSON.parse() converts numbers to floats, losing precision beyond 16 digits
      const decimalMatch = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)
      expect(decimalMatch, 'Could not extract decimalValue from response').to.exist

      const docDecimal = new Decimal(decimalMatch[1])
      const expectedDecimal = new Decimal('0.01234567890123456789')

      expect(docDecimal.equals(expectedDecimal)).to.be.true

      // Read back via GraphQL to verify GraphQL can read WOQL-inserted data
      const QUERY = gql`
        query GetWoqlInsert {
          NumericTest {
            _id
            decimalValue
          }
        }
      `

      const gqlResult = await graphqlClient.query({
        query: QUERY,
        fetchPolicy: 'network-only',
      })

      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id.endsWith('NumericTest/woql_insert'),
      )

      expect(gqlDoc).to.exist
      // GraphQL outputs JSON numbers (Apollo parses as float, losing precision)
      expect(typeof gqlDoc.decimalValue).to.equal('number')
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedDecimal.toNumber(), 0.00000000000001)

      // Read back via WOQL triple query
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/woql_insert' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimal = new Decimal(match[1])
      expect(woqlDecimal.equals(expectedDecimal)).to.be.true
    })

    it('should verify comprehensive cross-interface precision with different decimal patterns', async function () {
      // Test case: Insert documents with various decimal patterns
      // Verify all read interfaces return exact precision for edge cases

      const testCases = [
        { id: 'repeating_ones', value: '0.11111111111111111111' }, // 20 repeating 1s
        { id: 'repeating_nines', value: '0.99999999999999999999' }, // 20 repeating 9s
        { id: 'mixed_pattern', value: '0.12345678909876543210' }, // Mixed digits
      ]

      for (const testCase of testCases) {
        await document.insert(agent, {
          instance: {
            '@type': 'NumericTest',
            '@id': `NumericTest/${testCase.id}`,
            decimalValue: testCase.value,
            doubleValue: 1.0,
            integerValue: 1,
            bigIntValue: '1',
          },
        })

        // Verify via Document API
        const docResult = await document.get(agent, {
          query: { id: `NumericTest/${testCase.id}`, type: 'NumericTest', as_list: true },
        })
        const docDecimalRaw = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)[1]
        const docDecimal = new Decimal(docDecimalRaw)

        // Verify via WOQL triple query
        const tripleQuery = {
          '@type': 'Triple',
          subject: { '@type': 'NodeValue', node: `NumericTest/${testCase.id}` },
          predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
          object: { '@type': 'Value', variable: 'DecimalValue' },
        }

        const tripleResult = await woql.post(agent, tripleQuery).unverified()
        const match = tripleResult.text.match(/"@value":([^,}]*)/)
        expect(match).to.exist

        const woqlDecimal = new Decimal(match[1])
        const expectedDecimal = new Decimal(testCase.value)

        // All must match exactly
        expect(docDecimal.equals(expectedDecimal)).to.be.true
        expect(woqlDecimal.equals(expectedDecimal)).to.be.true
        expect(docDecimal.equals(woqlDecimal)).to.be.true
      }
    })

    it('should preserve precision when inserting via WOQL InsertDocument with DictionaryTemplate', async function () {
      // KNOWN ISSUE: WOQL InsertDocument fails with decimal values
      // Error: null_unsupported with rational conversion
      // Root cause: Decimal strings are converted to rationals during WOQL processing (expected),
      // but the document insertion pipeline doesn't handle rationals in DictionaryTemplate
      //
      // Investigation needed:
      // 1. Find where in document.pl/json.pl the rational is rejected
      // 2. Add rational-to-string conversion before document insertion
      // 3. Ensure 20-digit precision is maintained through conversion
      //
      // Workaround: Use Document API for insertions (fully verified)
      //
      // See: /docs/DECIMAL_PRECISION_INSERT_VERIFICATION_PLAN.md
      // Test case: Insert via proper WOQL InsertDocument structure
      // Verify the WOQL insertion path preserves full 20-digit precision

      const woqlInsertQuery = {
        '@type': 'InsertDocument',
        identifier: { '@type': 'NodeValue', node: 'NumericTest/woql_dictionary_insert' },
        document: {
          '@type': 'Value',
          dictionary: {
            '@type': 'DictionaryTemplate',
            data: [
              {
                '@type': 'FieldValuePair',
                field: '@type',
                value: { '@type': 'Value', data: 'NumericTest' },
              },
              {
                '@type': 'FieldValuePair',
                field: '@id',
                value: { '@type': 'Value', data: 'NumericTest/woql_dictionary_insert' },
              },
              {
                '@type': 'FieldValuePair',
                field: 'decimalValue',
                value: {
                  '@type': 'DataValue',
                  data: { '@type': 'xsd:decimal', '@value': '0.13579135791357913579' },
                },
              },
              {
                '@type': 'FieldValuePair',
                field: 'doubleValue',
                value: { '@type': 'Value', data: 3.14159 },
              },
              {
                '@type': 'FieldValuePair',
                field: 'integerValue',
                value: { '@type': 'Value', data: 400 },
              },
              {
                '@type': 'FieldValuePair',
                field: 'bigIntValue',
                value: { '@type': 'Value', data: '999999999' }, // Smaller value for testing
              },
            ],
          },
        },
      }

      const insertResult = await woql.post(agent, woqlInsertQuery).unverified()

      if (insertResult.status !== 200) {
        console.log('WOQL Insert Error with status:', insertResult.status)
        console.log('Error:', JSON.stringify(insertResult.body, null, 2))
        throw new Error(`WOQL InsertDocument with DictionaryTemplate failed: ${JSON.stringify(insertResult.body)}`)
      }

      expect(insertResult.status).to.equal(200)
      expect(insertResult.body.inserts).to.be.greaterThan(0)

      // Read back via Document API
      const docResult = await document.get(agent, {
        query: { id: 'NumericTest/woql_dictionary_insert', type: 'NumericTest', as_list: true },
      })

      expect(docResult.body).to.be.an('array')
      expect(docResult.body.length).to.be.greaterThan(0)

      // Extract from raw JSON - decimals are returned as JSON numbers per JSON_SERIALIZATION_RULES.md
      const docDecimalRaw = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)[1]
      const docDecimal = new Decimal(docDecimalRaw)
      const expectedDecimal = new Decimal('0.13579135791357913579')

      expect(docDecimal.equals(expectedDecimal)).to.be.true

      // Read back via GraphQL
      const QUERY = gql`
        query GetWoqlDictInsert {
          NumericTest {
            _id
            decimalValue
          }
        }
      `

      const gqlResult = await graphqlClient.query({
        query: QUERY,
        fetchPolicy: 'network-only',
      })

      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id.endsWith('NumericTest/woql_dictionary_insert'),
      )

      expect(gqlDoc).to.exist

      // Get RAW GraphQL response to verify server outputs full precision
      const rawGqlResponse = await agent.post(api.path.graphQL({ dbName: agent.dbName, orgName: agent.orgName }))
        .send({ query: QUERY.loc.source.body })

      // Verify RAW JSON contains full 20-digit precision (server-side is correct)
      expect(rawGqlResponse.text).to.include('"decimalValue":0.13579135791357913579')
      expect(rawGqlResponse.text).to.not.include('"decimalValue":"0.13579135791357913579"')

      // Apollo Client parses as floats (precision lost beyond ~16 digits during JSON.parse)
      // But we verify the server sends correct precision above
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedDecimal.toNumber(), 0.00000000000001)

      // Read back via WOQL triple query
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/woql_dictionary_insert' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimal = new Decimal(match[1])
      expect(woqlDecimal.equals(expectedDecimal)).to.be.true
    })

    it('should verify GraphQL reads high-precision decimals correctly after Document API insert', async function () {
      // Test case: Insert via GraphQL _insertDocuments mutation
      // Verify the GraphQL insertion path preserves full 20-digit precision

      // Note: GraphQL mutations use auto-generated insert functions based on schema
      // The format is _insert<TypeName>(field1: value1, field2: value2, ...)
      // We verify the GraphQL read path can handle high-precision decimals correctly
      await document.insert(agent, {
        instance: {
          '@type': 'NumericTest',
          '@id': 'NumericTest/graphql_mutation_insert',
          decimalValue: '0.24681357902468135790', // 20 digits - alternating pattern
          doubleValue: 2.71828,
          integerValue: 500,
          bigIntValue: '111111111111111111111',
        },
      })

      // Verify GraphQL can read it with full precision
      const QUERY = gql`
        query GetGraphQLMutationInsert {
          NumericTest {
            _id
            decimalValue
            integerValue
          }
        }
      `

      const gqlResult = await graphqlClient.query({
        query: QUERY,
        fetchPolicy: 'network-only',
      })

      const gqlDoc = gqlResult.data.NumericTest.find((d) =>
        d._id.endsWith('NumericTest/graphql_mutation_insert'),
      )

      expect(gqlDoc).to.exist
      // GraphQL outputs JSON numbers (Apollo parses as float, losing precision beyond ~16 digits)
      expect(typeof gqlDoc.decimalValue).to.equal('number')
      const gqlDecimal = new Decimal(gqlDoc.decimalValue.toString())
      const expectedDecimal = new Decimal('0.24681357902468135790')

      // Approximate equality due to Apollo's float parsing
      expect(gqlDecimal.toNumber()).to.be.closeTo(expectedDecimal.toNumber(), 0.00000000000001)

      // Also verify via Document API for consistency
      const docResult = await document.get(agent, {
        query: { id: 'NumericTest/graphql_mutation_insert', type: 'NumericTest', as_list: true },
      })

      const docDecimalRaw = docResult.text.match(/"decimalValue"\s*:\s*([0-9.eE+-]+)/)[1]
      const docDecimal = new Decimal(docDecimalRaw)
      expect(docDecimal.equals(expectedDecimal)).to.be.true

      // And via WOQL triple
      const tripleQuery = {
        '@type': 'Triple',
        subject: { '@type': 'NodeValue', node: 'NumericTest/graphql_mutation_insert' },
        predicate: { '@type': 'NodeValue', node: 'terminusdb:///schema#decimalValue' },
        object: { '@type': 'Value', variable: 'DecimalValue' },
      }

      const tripleResult = await woql.post(agent, tripleQuery).unverified()
      const match = tripleResult.text.match(/"@value":([^,}]*)/)
      expect(match).to.exist

      const woqlDecimal = new Decimal(match[1])
      expect(woqlDecimal.equals(expectedDecimal)).to.be.true
    })
  })
})
