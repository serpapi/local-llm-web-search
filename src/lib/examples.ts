// Example questions, one per SerpApi engine plus offline / direct-answer
// prompts. Shown in a popover next to the Send button so the chat area
// stays clean.
export type ExampleQuestion = {
  label: string
  question: string
}

export type ExampleGroup = {
  title: string
  description: string
  items: Array<ExampleQuestion>
}

// A flight date ~2 months out, computed when the examples are built so
// the Flights example never points at a past date as the app ages.
function exampleFlightDate(): string {
  const d = new Date()
  d.setMonth(d.getMonth() + 2)
  return d.toISOString().slice(0, 10)
}

// A 3-night hotel stay on the same horizon as the flight example, so the
// trip-planning example reads as one coherent itinerary.
function exampleHotelDates(): { checkIn: string; checkOut: string } {
  const checkIn = new Date()
  checkIn.setMonth(checkIn.getMonth() + 2)
  const checkOut = new Date(checkIn)
  checkOut.setDate(checkOut.getDate() + 3)
  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  }
}

export function buildExamples(): Array<ExampleGroup> {
  return [
    {
      title: "Live data",
      description: "One question per SerpApi engine.",
      items: [
        {
          label: "Search",
          question: "Who is the current CEO of Apple?",
        },
        {
          label: "Finance",
          question: "What's the current price of NVDA?",
        },
        {
          label: "News",
          question: "Top headlines about the EU AI Act this week",
        },
        {
          label: "Maps",
          question: "Best barbecue restaurants in Austin, Texas",
        },
        {
          label: "Flights",
          question: `Flights from JFK to LAX on ${exampleFlightDate()}`,
        },
        {
          label: "Hotels",
          question: `Hotels in Barcelona from ${exampleHotelDates().checkIn} to ${exampleHotelDates().checkOut} for 2 adults`,
        },
        {
          label: "Shopping",
          question: "Best price for AirPods Pro",
        },
      ],
    },
    {
      title: "No tools",
      description: "The model should answer without calling SerpApi.",
      items: [
        { label: "Arithmetic", question: "What is 2+2?" },
        { label: "Percentage", question: "What is 15% of 240?" },
        { label: "Creative", question: "Write a haiku about API tokens" },
        {
          label: "Translation",
          question: 'Translate "thank you" to Japanese',
        },
      ],
    },
    {
      title: "Parallel tool calls",
      description: "Two SerpApi calls in one turn.",
      items: [
        {
          label: "Multi-entity",
          question: "Compare the current prices of AAPL and TSLA",
        },
        {
          label: "Trip planning",
          question: `Find flights from JFK to BCN on ${exampleHotelDates().checkIn} and hotels in Barcelona from ${exampleHotelDates().checkIn} to ${exampleHotelDates().checkOut}`,
        },
      ],
    },
  ]
}
